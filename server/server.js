/**
 * ═══════════════════════════════════════════════════════════════
 *   GUADALUPE NATIONAL HIGH SCHOOL — QUIZ SYSTEM
 *
 *   Created by: Julius Celio
 *   Copyright (c) Julius Celio. All Rights Reserved.
 *
 *   This software is the intellectual property of Julius Celio
 *   and is licensed exclusively for use by Guadalupe National
 *   High School. Unauthorized copying, distribution, resale, or
 *   use outside of this institution is strictly prohibited.
 *
 *   NOT FOR SALE.
 * ═══════════════════════════════════════════════════════════════
 */

require("./license-check.js").checkLicense();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const mammoth = require("mammoth");
const beacon = require("./beacon.js"); // LAN auto-discovery for the student app

// All saved data (results, roster, item bank, pictures...) lives in DATA_DIR.
// The teacher app points this at its own data folder; plain npm start keeps the old behavior.
const DATA_DIR = process.env.GNHS_DATA_DIR || __dirname;

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" },
  pingTimeout: 60000,
  pingInterval: 25000,
});

// ── Configuration ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.resolve(DATA_DIR, "quiz-data.json");
const STUDENTS_FILE = path.resolve(DATA_DIR, "students.json");
const POINTS_FILE = path.resolve(DATA_DIR, "points.json");
const SESSIONS_FILE = path.resolve(DATA_DIR, "in-progress-sessions.json");
const ARCHIVE_FILE = path.resolve(DATA_DIR, "quiz-archive.json");
const QUESTION_HISTORY_FILE = path.resolve(DATA_DIR, "question-history.json");
const ITEM_BANK_FILE = path.resolve(DATA_DIR, "item-bank.json");
const ACTIVE_QUIZ_FILE = path.resolve(DATA_DIR, "active-quiz.json");
const QUIZ_DURATION_FILE = path.resolve(DATA_DIR, "quiz-duration.json");
const ARCHIVE_BACKUP_FILE = path.resolve(DATA_DIR, "quiz-archive.backup.json");
const EXAM_TYPE_FILE = path.resolve(DATA_DIR, "exam-type.json");

// ── Crash-safe file I/O ───────────────────────────────────────────────────────
// Every JSON file in this app used to be written with a single direct
// atomicWriteFileSync(file, data) call. That's NOT atomic: if the process is
// killed mid-write (laptop shutdown, power loss, force-quit — anything that
// doesn't let node finish the syscall) the file can be left truncated or
// corrupted. On the next server start, JSON.parse() on that file throws,
// the loader's catch block just logs to a console nobody is watching, and
// the in-memory data silently falls back to empty — data that LOOKS lost
// even though nothing was ever actually deleted on purpose.
//
// Fix: write to a temp file in the same directory, then fs.renameSync() it
// over the real file. rename() on the same filesystem is atomic — the real
// file either has the old complete contents or the new complete contents,
// never a half-written mix, no matter when the process dies.
function atomicWriteFileSync(filePath, contents) {
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeSync(fd, contents);
    fs.fsyncSync(fd); // force the OS to flush to disk before we consider this "saved"
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(tmpPath, filePath); // atomic on POSIX + Windows (same volume)
  } catch (err) {
    try { fs.unlinkSync(tmpPath); } catch {} // don't leave stray .tmp files behind
    throw err;
  }
}

// If a JSON file fails to parse, don't just shrug and continue with empty
// data — move the bad file aside (so nothing overwrites it / it's there for
// forensics) and shout loudly, so a corrupt file is never mistaken for "there
// was never any data here."
function quarantineCorruptFile(filePath, err) {
  try {
    const quarantinePath = `${filePath}.corrupt-${Date.now()}`;
    fs.renameSync(filePath, quarantinePath);
    console.error(`🚨🚨🚨 ${path.basename(filePath)} was corrupted and could NOT be read (${err.message}).`);
    console.error(`🚨🚨🚨 The bad file was preserved at: ${quarantinePath}`);
    console.error(`🚨🚨🚨 Do NOT run a new quiz until this is investigated — data may be recoverable from it or from a backup.`);
  } catch (moveErr) {
    console.error(`🚨🚨🚨 ${path.basename(filePath)} was corrupted AND could not even be quarantined:`, moveErr.message);
  }
}
const STUDENT_QUESTIONS_FILE = path.resolve(DATA_DIR, "student-questions.json");
const RESET_PASSWORD = process.env.RESET_PASSWORD || "303457guad";
const DEFAULT_QUIZ_DURATION_MINUTES = 60;
const MIN_QUIZ_DURATION_MINUTES = 1;
const MAX_QUIZ_DURATION_MINUTES = 480; // 8 hours, sanity ceiling

// Teacher-adjustable exam duration, set from the dashboard. Kept as a mutable
// variable (not a const) so admins can change it without restarting the
// server; persisted to quiz-duration.json so it survives a restart too.
let quizDurationMinutes = DEFAULT_QUIZ_DURATION_MINUTES;
function getQuizDurationMs() {
  return quizDurationMinutes * 60 * 1000;
}
// Duration for one specific exam (per section-subject).
function getExamDurationMs(exam) {
  return (exam ? exam.durationMinutes : quizDurationMinutes) * 60 * 1000;
}

// ── Grade / Section / Subject structure ─────────────────────────────────────
// Single source of truth for the school's Grade 7-10 sections and the 8
// DepEd subjects taught in every section. Everything else (SECTION_KEY_MAP,
// SECTION_ORDER, the dashboard's section list, the /api/structure endpoint)
// is derived from this so there's only one place to edit when a section or
// subject changes.
const SUBJECTS = [
  "Filipino", "English", "Math", "Science", "AP", "Values Education", "MAPEH", "TLE",
];

const GRADE_STRUCTURE = {
  "Grade 7":  ["RIZAL", "BONIFACIO"],
  "Grade 8":  ["AQUINO", "MABINI", "JACINTO"],
  "Grade 9":  ["DEL PILAR", "JUAN LUNA"],
  "Grade 10": ["DAGOHOY", "SILANG"],
};

// ── Section key mapping ───────────────────────────────────────────────────────
// students.json stores each student's plain section name (e.g. "SILANG"), but
// every section is tracked (and archived/reset, enabled/disabled) separately
// on the dashboard by subject, so the dashboard identifies them with a
// subject-suffixed key (e.g. "SILANG-MATH"). This map converts the raw
// section name to that dashboard key at login time, so every downstream
// record (gradeSection, activeSessions, archives, per-section reset) uses
// the same key the dashboard filters on.
//
// Built programmatically from GRADE_STRUCTURE × SUBJECTS: every section maps
// to an object keyed by subject (uppercased), so every student must select a
// subject at login before a key can be resolved. Sections not listed here
// (there shouldn't be any) pass through unchanged.
const SECTION_KEY_MAP = {};
// Every section+subject dashboard key that can ever exist (e.g. "RIZAL-MATH")
// — used to validate admin actions before they're trusted.
const ALL_SECTION_SUBJECT_KEYS = [];
// key -> raw section name, the inverse of the lookup above.
const SECTION_OF_KEY = {};
for (const sections of Object.values(GRADE_STRUCTURE)) {
  for (const section of sections) {
    const entry = {};
    for (const subject of SUBJECTS) {
      const key = `${section}-${subject.toUpperCase()}`;
      entry[subject.toUpperCase()] = key;
      ALL_SECTION_SUBJECT_KEYS.push(key);
      SECTION_OF_KEY[key] = section;
    }
    SECTION_KEY_MAP[section] = entry;
  }
}

// All valid section names, used to validate any section name coming from
// an admin action before it's trusted (persisted, broadcast, etc).
const ALL_SECTIONS = Object.values(GRADE_STRUCTURE).flat();

// Subject-sections (e.g. "RIZAL-MATH") a teacher has explicitly turned on
// for students. Every subject-section is DISABLED BY DEFAULT — a brand new
// section/subject combo, or a fresh install with no saved state, starts
// hidden from the student login page until a teacher enables it from the
// dashboard's Sections tab. Students in a subject-section that isn't
// enabled cannot log in or submit for it — the roster excludes it and the
// login handler rejects it outright, even if someone bypasses the client
// and emits student-login directly with one of these section/subject
// combos.
//
// Persisted to ENABLED_SECTIONS_FILE so the setting survives a server
// restart, and toggled at runtime from the dashboard's Sections tab via the
// "admin-toggle-section" socket event below.
const ENABLED_SECTIONS_FILE = path.resolve(DATA_DIR, "enabled-sections.json");
// Older versions of this app disabled/enabled a whole raw section at once
// (e.g. "RIZAL", covering all 8 subjects). If enabled-sections.json doesn't
// exist yet but this legacy file does, it's used once to migrate: every
// subject under a section that was NOT in the legacy disabled list starts
// enabled, everything else starts disabled — matching the new default.
const LEGACY_DISABLED_SECTIONS_FILE = path.resolve(DATA_DIR, "disabled-sections.json");

function loadEnabledSections() {
  try {
    const raw = JSON.parse(fs.readFileSync(ENABLED_SECTIONS_FILE, "utf8"));
    // Only trust keys that are still real section+subject combos — guards
    // against a hand-edited or stale file listing one that no longer exists.
    if (Array.isArray(raw)) return raw.filter(k => ALL_SECTION_SUBJECT_KEYS.includes(k));
  } catch {
    // No enabled-sections.json yet — fall through to a possible legacy
    // migration below, or the "everything disabled" default.
  }

  try {
    const legacyRaw = JSON.parse(fs.readFileSync(LEGACY_DISABLED_SECTIONS_FILE, "utf8"));
    if (Array.isArray(legacyRaw)) {
      const legacyDisabledSections = new Set(legacyRaw);
      const migrated = ALL_SECTION_SUBJECT_KEYS.filter(key => !legacyDisabledSections.has(SECTION_OF_KEY[key]));
      console.log("📚 Migrated legacy disabled-sections.json → enabled-sections.json (now per-subject, disabled by default).");
      try {
        atomicWriteFileSync(ENABLED_SECTIONS_FILE, JSON.stringify(migrated, null, 2));
      } catch (err) {
        console.error("⚠️  Failed to save migrated enabled-sections.json:", err.message);
      }
      return migrated;
    }
  } catch {
    // No legacy file either — every subject-section starts disabled.
  }

  return [];
}

function saveEnabledSections() {
  try {
    atomicWriteFileSync(ENABLED_SECTIONS_FILE, JSON.stringify(ENABLED_SECTIONS, null, 2));
  } catch (err) {
    console.error("⚠️  Failed to save enabled-sections.json:", err.message);
  }
}

let ENABLED_SECTIONS = loadEnabledSections();

// True if a raw section has at least one enabled subject — used to decide
// whether the section should appear at all on the student login page (the
// subject itself is picked afterward, so a section stays visible as long as
// one of its subjects is open).
function sectionHasAnyEnabledSubject(rawSection) {
  const entry = SECTION_KEY_MAP[rawSection];
  if (entry === undefined) return true; // not a tracked section — don't hide it
  return Object.values(entry).some(key => ENABLED_SECTIONS.includes(key));
}

// The subjects currently enabled for a raw section, in SUBJECTS order — sent
// to the student login page as part of the roster so its subject dropdown
// only offers subjects that are actually open for that section.
function enabledSubjectsForSection(rawSection) {
  const entry = SECTION_KEY_MAP[rawSection];
  if (entry === undefined) return SUBJECTS.slice();
  return SUBJECTS.filter(subject => ENABLED_SECTIONS.includes(entry[subject.toUpperCase()]));
}

// Returns the resolved dashboard key, or null if a subject was required but
// missing/invalid. Callers must check for null before using the result.
function sectionKey(rawSection, rawSubject) {
  const entry = SECTION_KEY_MAP[rawSection];
  if (entry === undefined) return rawSection;
  if (typeof entry === "string") return entry;
  const subject = String(rawSubject || "").trim().toUpperCase();
  return entry[subject] || null;
}

// True if this raw section requires a subject to be supplied at login.
function sectionRequiresSubject(rawSection) {
  const entry = SECTION_KEY_MAP[rawSection];
  return entry !== undefined && typeof entry !== "string";
}
const GRACE_PERIOD_MS = 30_000;
const MAX_TAB_SWITCHES = 5;
const MAX_LOGIN_ATTEMPTS = 5;
const RATE_LIMIT_WINDOW_MS = 60_000;

// ── In-memory state ──────────────────────────────────────────────────────────
let submissions = [];
let itemCount = 0;
let studentList = [];
let quizOpen = false;   // Quiz is LOCKED by default until teacher opens it
let resultsVisible = true;   // When false, students can't see their score/review after submitting
let currentExamType = "Quiz";   // "Quiz", "Summative Test", or "Term Examination" — shown on the student login/quiz screen

// Valid exam types + a helper to normalize any incoming value to one of them (defaults to "Quiz").
const EXAM_TYPES = ["Quiz", "Summative Test", "Term Examination"];
function normalizeExamType(t) { return EXAM_TYPES.includes(t) ? t : "Quiz"; }

// The selected exam type is saved to exam-type.json so it survives a server
// restart / laptop shutdown. Before this, it silently went back to "Quiz" on
// every start, which meant a Summative Test or Term Examination could be
// archived under "Quiz" by mistake.
function saveExamType() {
  try {
    atomicWriteFileSync(EXAM_TYPE_FILE, JSON.stringify({ examType: currentExamType }, null, 2));
  } catch (err) {
    console.error("❌ Failed to save exam-type.json:", err.message);
  }
}

function loadExamType() {
  if (!fs.existsSync(EXAM_TYPE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(EXAM_TYPE_FILE, "utf8"));
    currentExamType = normalizeExamType(data && data.examType);
    console.log(`📝 Loaded exam type: ${currentExamType}`);
  } catch (err) {
    console.error("❌ Error loading exam-type.json:", err.message);
    quarantineCorruptFile(EXAM_TYPE_FILE, err);
  }
}

// Best-guess type for OLD archive entries that were saved before exam types
// existed (their examType is missing). Only used to fill in blanks — an entry
// that already has a valid type is never touched.
function inferExamTypeFromName(name) {
  const n = String(name || "");
  if (/summative/i.test(n)) return "Summative Test";
  if (/term\s*exam|term\s*examination|quarterly|periodical/i.test(n)) return "Term Examination";
  return "Quiz";
}

// Valid item types. Missing/unrecognized values default to "mc" for
// backward compatibility with items/questions saved before identification
// and matching items existed.
function normalizeItemType(t) {
  if (t === "identification") return "identification";
  if (t === "matching") return "matching";
  return "mc";
}

// Normalizes a stored identification answer for grading: trims, collapses
// internal whitespace to single spaces, and lowercases — so "Paris", " paris ",
// and "PARIS" all compare equal, but wording differences still don't.
function normalizeIdentificationAnswer(s) {
  return String(s ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}
let questionPoints = {};   // { [questionNum]: pointValue } — defaults to 1 for any item not set

// Permanent record of every exam run on this server, independent of the live
// "submissions" array. A reset normally wipes "submissions" — entries here are
// never touched by a reset, so past exams stay retrievable indefinitely
// (survives resets, and server restarts, since it's persisted to disk).
let quizArchive = [];
// Snapshots of the realQuestions array, saved on demand from the dashboard
// toolbar ("Snapshot Questions"). Unlike quizArchive, this has nothing to do
// with submissions — it's just a running log of every question set you've
// ever had loaded in server.js, so you can look back at what you asked even
// if that particular version was never formally archived.
let questionHistory = [];

// Track per-IP/socket login failures  { socketId → { count, windowStart } }
const loginAttempts = new Map();

// Live sessions: studentId → session object (for the dashboard's "who's online now" view)
const activeSessions = new Map();

// In-progress quiz sessions: studentId → full session state (shuffled questions,
// correct answers, timers, integrity counters). This is the source of truth for
// "resume" — it lives independently of any one socket, so a student can close
// the browser, lose WiFi, or reopen the tab and pick up right where they left
// off instead of being forced into a fresh (re-shuffled, re-timed) attempt.
const studentSessions = new Map();

// ── Item Bank (server-side only) ──────────────────────────────────────────────
// A persistent pool of MC items, added one-by-one from the dashboard. Separate
// from realQuestions (the live quiz) — you build up the bank over time, then
// draw a random N-item subset from it to become the live quiz on demand.
let itemBank = [];

// ── Questions (server-side only – correct answers never leave this file) ─────
// DEFAULT_QUESTIONS is the original hardcoded 15-item set. realQuestions is
// the LIVE set students actually get quizzed on — it starts as a copy of the
// default set, but can be overwritten at runtime by generating a quiz from
// the Item Bank (via the dashboard), without touching this file or restarting
// the server. Whatever's live gets persisted to active-quiz.json so a restart
// doesn't silently snap back to the default set.
const DEFAULT_QUESTIONS = [
  { num: 1, q: "According to the lab, why do mathematicians need exact definitions instead of relying on how a shape “looks”?", choices: ["Because shapes are always drawn incorrectly", "Because “close enough” can lead to misunderstandings, and math requires rules to test reality", "Because only artists need visual judgment", "Because calculators cannot read shapes"], correct: 1 },
  { num: 2, q: "Which of the following is NOT one of the three baseline conditions for a quadrilateral?", choices: ["Exactly 4 sides", "Exactly 4 vertices", "Interior angles sum to 360°", "All sides must be equal in length"], correct: 3 },
  { num: 3, q: "A quadrilateral has exactly how many vertices?", choices: ["3", "4", "5", "It varies"], correct: 1 },
  { num: 4, q: "The sum of the interior angles of any quadrilateral is:", choices: ["180°", "270°", "360°", "540°"], correct: 2 },
  { num: 5, q: "In the “360° Proof,” a quadrilateral is split into two shapes using a diagonal. What are those two shapes?", choices: ["Two squares", "Two triangles", "Two pentagons", "A triangle and a square"], correct: 1 },
  { num: 6, q: "The 360° proof works because:", choices: ["180° × 4 = 360°", "Each triangle formed contributes 180°, and 180° + 180° = 360°", "A quadrilateral has no diagonals", "Triangles and quadrilaterals have the same angle sum"], correct: 1 },
  { num: 7, q: "The Classification Lab introduces two diagnostic tests. What are they?", choices: ["The Angle Test and the Side Test", "The Boundary Test and the Diagonal Test", "The Symmetry Test and the Perimeter Test", "The Area Test and the Vertex Test"], correct: 1 },
  { num: 8, q: "In Test 1 (The Boundary Tracer), a quadrilateral is classified as complex when:", choices: ["Its diagonals cross outside the shape", "Its sides cross over each other", "It has more than four sides", "Its angles do not sum to 360°"], correct: 1 },
  { num: 9, q: "A simple quadrilateral, based on the Boundary Test, is one where:", choices: ["The boundary never crosses itself", "All four sides are equal", "The diagonals are equal in length", "It has at least one right angle"], correct: 0 },
  { num: 10, q: "According to Test 2 (The Diagonal Laser), a quadrilateral is classified as convex when:", choices: ["At least one diagonal falls outside the shape", "Both diagonals stay completely inside the shape", "The shape has no diagonals at all", "The sides cross like a bowtie"], correct: 1 },
  { num: 11, q: "In “The Breach” slide, a shape is identified as non-convex because:", choices: ["One of its sides is longer than the others", "A single diagonal falls outside the boundary of the shape", "It has fewer than four vertices", "Its interior angles do not sum to 360°"], correct: 1 },
  { num: 12, q: "A dart or arrow-shaped quadrilateral (like the one in “The Breach”) would be classified as:", choices: ["Simple and convex", "Simple and non-convex", "Complex and convex", "Complex and non-convex"], correct: 1 },
  { num: 13, q: "According to the Quadrilateral Diagnostic Matrix, which combination is described as “Mathematically Impossible”?", choices: ["Simple and Convex", "Simple and Non-Convex", "Complex and Convex", "Complex and Non-Convex"], correct: 2 },
  { num: 14, q: "A classic “bowtie” shape, where the sides cross each other, would fall into which category on the Diagnostic Matrix?", choices: ["Simple / Convex", "Simple / Non-Convex", "Complex (only — convex classification does not apply)", "Convex / Non-Convex"], correct: 2 },
  { num: 15, q: "In the Universal Shape Classifier flowchart, if a shape has exactly 4 sides and its boundary lines do NOT cross, what is the very next question the flowchart asks to continue classifying it?", choices: ["Does it have exactly 4 vertices?", "Do the interior angles sum to 360°?", "Do any diagonals exit the shape?", "Is the shape symmetrical?"], correct: 2 }
];

// The live question set. Starts as the default set; may be replaced at
// runtime by "Generate Quiz" (drawing from the item bank) or reverted with
// "Restore Default Set" — both from the dashboard.
let realQuestions = DEFAULT_QUESTIONS;
// ── Crypto-safe shuffle using Fisher-Yates ────────────────────────────────────
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Orders a drawn set of item-bank items into fixed blocks — all Multiple
// Choice items first, then all Identification items, then all Matching
// items — shuffling ONLY within each block so items never mix across
// types in the final order. A type block is skipped entirely if no items
// of that type were drawn.
function groupByTypeThenShuffle(items) {
  const mc = items.filter(it => normalizeItemType(it.type) === "mc");
  const identification = items.filter(it => normalizeItemType(it.type) === "identification");
  const matching = items.filter(it => normalizeItemType(it.type) === "matching");
  return [
    ...keepPassageGroupsTogether(shuffle(mc)),
    ...keepPassageGroupsTogether(shuffle(identification)),
    ...shuffle(matching),
  ];
}

// Items that share the same reading passage / situation must stay next to each
// other so students read the passage once and answer its questions in a row.
// Takes an already-shuffled list and pulls every later item that has the same
// passage up behind the first one seen. Groups end up in random order (based on
// where their first member landed) and questions inside a group stay shuffled.
// Items with no passage are left exactly where the shuffle put them.
function keepPassageGroupsTogether(list) {
  const groups = new Map();
  const out = [];
  for (const it of list) {
    const key = passageKey(it.passage);
    if (!key) { out.push({ single: it }); continue; }
    if (!groups.has(key)) {
      const g = { group: [] };
      groups.set(key, g);
      out.push(g);
    }
    groups.get(key).group.push(it);
  }
  return out.flatMap(o => (o.group ? o.group : [o.single]));
}

// Normalised comparison key so a stray space or line-break difference between
// two copies of the same passage doesn't split the group.
function passageKey(passage) {
  return typeof passage === "string" ? passage.replace(/\s+/g, " ").trim().toLowerCase() : "";
}

// Cleans a passage for storage: trims each line, drops blank lines, and joins
// paragraphs with a single newline. Returns "" when there is no passage.
function cleanPassage(passage) {
  if (typeof passage !== "string") return "";
  return passage.split(/\r?\n/).map(l => l.trim()).filter(Boolean).join("\n");
}

// ── File I/O helpers ─────────────────────────────────────────────────────────
function loadStudents() {
  if (!fs.existsSync(STUDENTS_FILE)) {
    console.warn("⚠  students.json not found – login validation disabled");
    return;
  }
  try {
    studentList = JSON.parse(fs.readFileSync(STUDENTS_FILE, "utf8"));
    console.log(`✅ Loaded ${studentList.length} students`);
  } catch (err) {
    console.error("❌ Error loading students.json:", err.message);
    quarantineCorruptFile(STUDENTS_FILE, err);
  }
}

function loadData() {
  if (!fs.existsSync(DATA_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    submissions = data.submissions || [];
    itemCount   = data.itemCount   || 0;
    console.log(`✅ Loaded ${submissions.length} existing submissions`);
  } catch (err) {
    // Don't silently fall back to 0 submissions — a corrupt file here means
    // today's not-yet-archived scores are unreadable, not that they never
    // existed. Quarantine the bad file so it's never overwritten, and make
    // noise so this gets noticed before a new quiz starts.
    quarantineCorruptFile(DATA_FILE, err);
  }
}

function saveData() {
  try {
    atomicWriteFileSync(DATA_FILE, JSON.stringify({ submissions, itemCount }, null, 2));
  } catch (err) {
    console.error("❌ Failed to save quiz-data.json:", err.message);
  }
}

function loadArchive() {
  if (!fs.existsSync(ARCHIVE_FILE)) {
    // Main file missing entirely (e.g. deleted by accident) — see if a good
    // backup exists before assuming there's really nothing to load.
    tryRecoverArchiveFromBackup("quiz-archive.json is missing");
    return;
  }
  try {
    quizArchive = JSON.parse(fs.readFileSync(ARCHIVE_FILE, "utf8")) || [];
    console.log(`🗄  Loaded ${quizArchive.length} archived exam(s) from ${ARCHIVE_FILE}`);
  } catch (err) {
    // Main file exists but is corrupt (e.g. truncated by a mid-write
    // shutdown). Quarantine it, then fall back to the last known-good
    // backup instead of silently starting from an empty archive.
    quarantineCorruptFile(ARCHIVE_FILE, err);
    tryRecoverArchiveFromBackup(`quiz-archive.json was corrupt (${err.message})`);
  }
}

function tryRecoverArchiveFromBackup(reason) {
  if (!fs.existsSync(ARCHIVE_BACKUP_FILE)) {
    console.error(`❌ ${reason}, and no backup (${path.basename(ARCHIVE_BACKUP_FILE)}) was found either. Starting with an empty archive — check for a quiz-archive.json.corrupt-* file before running a new quiz.`);
    return;
  }
  try {
    const backup = JSON.parse(fs.readFileSync(ARCHIVE_BACKUP_FILE, "utf8")) || [];
    quizArchive = backup;
    console.warn(`♻️  ${reason} — recovered ${quizArchive.length} archived exam(s) from the backup copy instead.`);
    saveArchive(); // write the recovered data back as the primary file + refresh the backup
  } catch (err) {
    console.error(`🚨 ${reason}, and the backup copy was ALSO unreadable (${err.message}). Starting with an empty archive — check for .corrupt-* files before running a new quiz.`);
  }
}

// Returns true ONLY if the archive was written AND read back correctly from
// disk. A failure used to be just a console line nobody sees, while the
// dashboard still showed the scores (from memory) — so they looked saved,
// then were gone after a restart. Callers that matter (Archive & Reset) now
// check the result and refuse to reset if the save didn't really happen.
function saveArchive() {
  try {
    // Keep the previous file as a "last known good" backup, but ONLY if it
    // is actually readable — never overwrite a good backup with a bad file.
    // A backup problem must never stop the real save below.
    try {
      if (fs.existsSync(ARCHIVE_FILE)) {
        const current = JSON.parse(fs.readFileSync(ARCHIVE_FILE, "utf8"));
        if (Array.isArray(current)) fs.copyFileSync(ARCHIVE_FILE, ARCHIVE_BACKUP_FILE);
      }
    } catch (backupErr) {
      console.error("⚠  Could not refresh quiz-archive.backup.json:", backupErr.message);
    }
    atomicWriteFileSync(ARCHIVE_FILE, JSON.stringify(quizArchive, null, 2));
    // Read it back: confirm the data is really on disk and complete.
    const check = JSON.parse(fs.readFileSync(ARCHIVE_FILE, "utf8"));
    if (!Array.isArray(check) || check.length !== quizArchive.length) {
      throw new Error(`read-back mismatch (${Array.isArray(check) ? check.length : "not an array"} on disk vs ${quizArchive.length} in memory)`);
    }
    return true;
  } catch (err) {
    console.error("❌ Failed to save quiz-archive.json:", err.message);
    return false;
  }
}

// One-time cleanup: every archived exam must carry one of the three types
// (Quiz / Summative Test / Term Examination). Old entries with no type get one
// from their name and the archive is re-saved (the previous file is kept as
// quiz-archive.backup.json by saveArchive()).
function migrateArchiveExamTypes() {
  let fixed = 0;
  for (const entry of quizArchive) {
    if (!EXAM_TYPES.includes(entry.examType)) {
      entry.examType = inferExamTypeFromName(entry.name);
      fixed++;
      console.log(`🏷  Archive entry "${entry.name}" had no exam type — filed under "${entry.examType}".`);
    }
  }
  if (fixed > 0) {
    saveArchive();
    console.log(`🏷  Tagged ${fixed} archived exam(s) with an exam type.`);
  }
}

// Pulls a student's own past results out of every archived exam (quizArchive),
// most recent first. Used to show students their score history right after
// they log in for a new quiz. Only ever reads their own studentId — never
// exposes other students' submissions.
function getStudentHistory(studentId) {
  const history = [];
  for (const entry of quizArchive) {
    const sub = (entry.submissions || []).find(s => s.studentId === studentId);
    if (!sub) continue;
    history.push({
      examName:   entry.name || "Untitled Exam",
      examType:   entry.examType || null,
      archivedAt: entry.archivedAt,
      score:      sub.score,
      maxScore:   sub.maxScore ?? entry.maxScore,
      percentage: sub.percentage,
    });
  }
  history.sort((a, b) => new Date(b.archivedAt) - new Date(a.archivedAt));
  return history.slice(0, 10); // cap it — this is a quick glance, not a full transcript
}

function loadQuestionHistory() {
  if (!fs.existsSync(QUESTION_HISTORY_FILE)) return;
  try {
    questionHistory = JSON.parse(fs.readFileSync(QUESTION_HISTORY_FILE, "utf8")) || [];
    console.log(`📸 Loaded ${questionHistory.length} question snapshot(s)`);
  } catch (err) {
    console.error("❌ Error loading question-history.json:", err.message);
    quarantineCorruptFile(QUESTION_HISTORY_FILE, err);
  }
}

function saveQuestionHistory() {
  try {
    atomicWriteFileSync(QUESTION_HISTORY_FILE, JSON.stringify(questionHistory, null, 2));
  } catch (err) {
    console.error("❌ Failed to save question-history.json:", err.message);
  }
}

function loadItemBank() {
  if (!fs.existsSync(ITEM_BANK_FILE)) return;
  try {
    itemBank = JSON.parse(fs.readFileSync(ITEM_BANK_FILE, "utf8")) || [];
    console.log(`🗃  Loaded ${itemBank.length} item bank item(s)`);
  } catch (err) {
    console.error("❌ Error loading item-bank.json:", err.message);
    quarantineCorruptFile(ITEM_BANK_FILE, err);
  }
}

function saveItemBank() {
  try {
    atomicWriteFileSync(ITEM_BANK_FILE, JSON.stringify(itemBank, null, 2));
  } catch (err) {
    console.error("❌ Failed to save item-bank.json:", err.message);
  }
}

// Persists whichever question set is currently live (default or generated
// from the bank), so a server restart doesn't silently drop back to
// DEFAULT_QUESTIONS if the teacher had generated a custom quiz.
function saveActiveQuiz() {
  try {
    atomicWriteFileSync(ACTIVE_QUIZ_FILE, JSON.stringify({ questions: realQuestions }, null, 2));
  } catch (err) {
    console.error("❌ Failed to save active-quiz.json:", err.message);
  }
}

function loadActiveQuiz() {
  if (!fs.existsSync(ACTIVE_QUIZ_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(ACTIVE_QUIZ_FILE, "utf8"));
    if (Array.isArray(data.questions) && data.questions.length > 0) {
      realQuestions = data.questions;
      console.log(`🎲 Loaded active quiz (${realQuestions.length} item(s), generated from item bank)`);
    }
  } catch (err) {
    console.error("❌ Error loading active-quiz.json:", err.message);
    quarantineCorruptFile(ACTIVE_QUIZ_FILE, err);
  }
}

// Persists the teacher-configured exam duration so a server restart doesn't
// silently fall back to the 60-minute default.
function saveQuizDuration() {
  try {
    atomicWriteFileSync(QUIZ_DURATION_FILE, JSON.stringify({ minutes: quizDurationMinutes }, null, 2));
  } catch (err) {
    console.error("❌ Failed to save quiz-duration.json:", err.message);
  }
}

function loadQuizDuration() {
  if (!fs.existsSync(QUIZ_DURATION_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(QUIZ_DURATION_FILE, "utf8"));
    const minutes = Number(data.minutes);
    if (Number.isFinite(minutes) && minutes >= MIN_QUIZ_DURATION_MINUTES && minutes <= MAX_QUIZ_DURATION_MINUTES) {
      quizDurationMinutes = minutes;
      console.log(`⏱  Loaded exam duration: ${quizDurationMinutes} minute(s)`);
    }
  } catch (err) {
    console.error("❌ Error loading quiz-duration.json:", err.message);
    quarantineCorruptFile(QUIZ_DURATION_FILE, err);
  }
}

function loadPoints() {
  if (!fs.existsSync(POINTS_FILE)) return;
  try {
    questionPoints = JSON.parse(fs.readFileSync(POINTS_FILE, "utf8")) || {};
    console.log(`✅ Loaded custom item points for ${Object.keys(questionPoints).length} item(s)`);
  } catch (err) {
    console.error("❌ Error loading points.json:", err.message);
    quarantineCorruptFile(POINTS_FILE, err);
  }
}

function savePoints() {
  try {
    atomicWriteFileSync(POINTS_FILE, JSON.stringify(questionPoints, null, 2));
  } catch (err) {
    console.error("❌ Failed to save points.json:", err.message);
  }
}

// ── Private "ask the teacher" questions from students. One-way by design —
// students can send these, but there's no reply channel back to them from
// a teacher message (see admin-send-student-message above), so this never
// turns into a back-and-forth chat during the exam. ─────────────────────────
let studentQuestions = []; // { id, studentId, name, section, message, sentAt }
const MAX_STUDENT_QUESTION_LENGTH = 500;
const MAX_STORED_STUDENT_QUESTIONS = 1000;
const STUDENT_QUESTION_COOLDOWN_MS = 15000; // throttle so it can't be spammed
const studentQuestionCooldown = new Map(); // studentId -> last-sent timestamp

function loadStudentQuestions() {
  if (!fs.existsSync(STUDENT_QUESTIONS_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(STUDENT_QUESTIONS_FILE, "utf8"));
    if (Array.isArray(data)) studentQuestions = data;
    console.log(`✅ Loaded ${studentQuestions.length} saved student question(s)`);
  } catch (err) {
    console.error("❌ Error loading student-questions.json:", err.message);
    quarantineCorruptFile(STUDENT_QUESTIONS_FILE, err);
  }
}

function saveStudentQuestions() {
  try {
    atomicWriteFileSync(STUDENT_QUESTIONS_FILE, JSON.stringify(studentQuestions, null, 2));
  } catch (err) {
    console.error("❌ Failed to save student-questions.json:", err.message);
  }
}

// Persist in-progress sessions so a resume also survives the *server* being
// restarted (laptop sleep/crash/relaunch), not just the student's browser.
// Called sparingly (login, submit, kick, reset, and a periodic snapshot) —
// not on every keystroke — to avoid hammering disk I/O.
function saveInProgressSessions() {
  try {
    const plain = {};
    for (const [id, sd] of studentSessions.entries()) {
      if (sd.submitted) continue; // no need to keep finished sessions around
      plain[id] = sd;
    }
    atomicWriteFileSync(SESSIONS_FILE, JSON.stringify(plain, null, 2));
  } catch (err) {
    console.error("❌ Failed to save in-progress sessions:", err.message);
  }
}

// Coalesces frequent progress saves into one disk write every couple seconds.
let inProgressPersistTimer = null;
function scheduleSaveInProgress() {
  if (inProgressPersistTimer) return;
  inProgressPersistTimer = setTimeout(() => {
    inProgressPersistTimer = null;
    saveInProgressSessions();
  }, 2000);
}

function loadInProgressSessions() {
  if (!fs.existsSync(SESSIONS_FILE)) return;
  try {
    const plain = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8")) || {};
    const now = Date.now();
    let restored = 0;
    for (const [id, sd] of Object.entries(plain)) {
      // Drop anything whose time is already up — nothing to resume into.
      const sdDurationMs = sd?.durationMs ?? getQuizDurationMs();
      if (!sd || sd.submitted || (now - sd.startTime) > (sdDurationMs + GRACE_PERIOD_MS)) continue;
      studentSessions.set(id, sd);
      restored++;
    }
    if (restored > 0) console.log(`♻️  Restored ${restored} in-progress session(s) — students can resume where they left off`);
  } catch (err) {
    console.error("❌ Error loading in-progress-sessions.json:", err.message);
    quarantineCorruptFile(SESSIONS_FILE, err);
  }
}

// Points for a given question number (defaults to 1 if the teacher hasn't set one)
function getPoints(num, exam) {
  const p = (exam ? exam.points : questionPoints)[num];
  return typeof p === "number" && p > 0 ? p : 1;
}

// Sum of points across every item — this is the max possible score
function getMaxScore(exam) {
  const qs = exam ? exam.questions : realQuestions;
  return qs.reduce((sum, q) => sum + getPoints(q.num, exam), 0);
}

loadStudents();
loadData();
loadPoints();
loadArchive();
migrateArchiveExamTypes();
loadQuestionHistory();
loadInProgressSessions();
loadItemBank();
loadActiveQuiz();
loadQuizDuration();
loadExamType();
loadStudentQuestions();
itemCount = realQuestions.length;

// ── Per-section-subject exams ────────────────────────────────────────────────
// Each section-subject key (e.g. "VICENTE LIM-MATH") owns its own exam:
// questions, item points, duration, exam type and open/locked flag. This is
// what lets Math 7 and Science 8 run at the same time with different content.
// The legacy globals above (realQuestions, questionPoints, quizDurationMinutes,
// currentExamType) now only act as the SEED for a key's exam the first time it
// is touched, so existing active-quiz.json / points.json etc. still carry over.
// "Open" is deliberately not persisted (same as before: locked after restart).
const EXAMS_FILE = path.resolve(DATA_DIR, "exams.json");
const examsByKey = new Map();

function newExam() {
  return {
    questions:       realQuestions.map(q => ({ ...q })),
    points:          { ...questionPoints },
    durationMinutes: quizDurationMinutes,
    examType:        currentExamType,
    open:            false,
  };
}
function getExam(key) {
  if (!examsByKey.has(key)) examsByKey.set(key, newExam());
  return examsByKey.get(key);
}
function saveExams() {
  try {
    const out = {};
    for (const [k, e] of examsByKey) {
      out[k] = { questions: e.questions, points: e.points, durationMinutes: e.durationMinutes, examType: e.examType };
    }
    atomicWriteFileSync(EXAMS_FILE, JSON.stringify(out, null, 2));
  } catch (err) {
    console.error("❌ Failed to save exams.json:", err.message);
  }
}
function loadExams() {
  if (!fs.existsSync(EXAMS_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(EXAMS_FILE, "utf8")) || {};
    for (const [k, e] of Object.entries(data)) {
      if (!e || !Array.isArray(e.questions) || !e.questions.length) continue;
      const minutes = Number(e.durationMinutes);
      examsByKey.set(k, {
        questions:       e.questions,
        points:          e.points || {},
        durationMinutes: Number.isFinite(minutes) && minutes >= MIN_QUIZ_DURATION_MINUTES && minutes <= MAX_QUIZ_DURATION_MINUTES ? minutes : DEFAULT_QUIZ_DURATION_MINUTES,
        examType:        normalizeExamType(e.examType),
        open:            false,
      });
    }
    console.log(`📚 Loaded ${examsByKey.size} per-section exam(s) from exams.json`);
  } catch (err) {
    console.error("❌ Error loading exams.json:", err.message);
    quarantineCorruptFile(EXAMS_FILE, err);
  }
}
loadExams();

// Summary for the dashboard / student page. Only keys that have been touched
// are listed; any other enabled key is implicitly locked.
function examStatusMap() {
  const out = {};
  for (const [k, e] of examsByKey) {
    out[k] = { open: e.open, examType: e.examType, durationMinutes: e.durationMinutes, itemCount: e.questions.length, maxScore: getMaxScore(e) };
  }
  return out;
}
function broadcastExamStatus() { io.emit("exam-status-map", { statuses: examStatusMap() }); }

// Validates a sectionKey sent by an admin event. Returns the normalised key or null.
function resolveAdminKey(raw) {
  const k = String(raw ?? "").trim().toUpperCase();
  return ALL_SECTION_SUBJECT_KEYS.includes(k) ? k : null;
}

// ── Express ──────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());
beacon.registerPing(app, PORT);

// ── Item pictures ────────────────────────────────────────────────────────────
// Teachers attach a picture to an item manually in the dashboard's Item Bank
// form. The file is saved here and only its short URL path is stored on the
// item (item.image), so the JSON data files stay small.
const ITEM_IMAGE_DIR = path.resolve(DATA_DIR, "item-images");
if (!fs.existsSync(ITEM_IMAGE_DIR)) fs.mkdirSync(ITEM_IMAGE_DIR, { recursive: true });
app.use("/item-images", express.static(ITEM_IMAGE_DIR, { maxAge: "7d" }));

const ITEM_IMAGE_EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
const itemImageUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Returns a safe stored image path ("/item-images/<name>.<ext>") or "" if the
// value is empty, malformed, or points at a file that doesn't exist.
function cleanImage(image) {
  if (typeof image !== "string") return "";
  const m = image.trim().match(/^\/item-images\/([a-z0-9_-]+\.(?:jpg|png|webp|gif))$/i);
  if (!m) return "";
  return fs.existsSync(path.join(ITEM_IMAGE_DIR, m[1])) ? `/item-images/${m[1]}` : "";
}

app.post("/api/item-image", itemImageUpload.single("image"), (req, res) => {
  if ((req.body?.password ?? "") !== RESET_PASSWORD) {
    return res.status(403).json({ ok: false, message: "Incorrect password." });
  }
  if (!req.file) {
    return res.status(400).json({ ok: false, message: "No image uploaded." });
  }
  const ext = ITEM_IMAGE_EXT[req.file.mimetype];
  if (!ext) {
    return res.status(400).json({ ok: false, message: "Only JPG, PNG, WebP or GIF images are allowed." });
  }
  const name = `img_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`;
  try {
    fs.writeFileSync(path.join(ITEM_IMAGE_DIR, name), req.file.buffer);
  } catch (err) {
    console.error("Item image save failed:", err);
    return res.status(500).json({ ok: false, message: "Could not save the image." });
  }
  res.json({ ok: true, path: `/item-images/${name}` });
});

// ── Item Bank — import MC + Identification questions from a .docx ────────────
// Format the parser expects (see MC_Import_Template.docx / Identification_Import_Template.docx):
//   TOPIC: <name>                 (optional; carries forward until the next TOPIC: line)
//   COMPETENCY: <text>            (optional; carries forward until the next COMPETENCY:
//                                  or TOPIC: line — a new TOPIC: clears it back to blank,
//                                  same "falls back to Topic if left blank" rule as the
//                                  Add Item form)
//
//   PASSAGE: <text>              (optional; a situation / paragraph / reading text
//                                  shown above the question. May run over several
//                                  lines — the text ends at the first numbered
//                                  question. It then applies to every question
//                                  that follows until "END PASSAGE", the next
//                                  PASSAGE:, or a new COMPETENCY:/TOPIC: line.)
//   END PASSAGE                   (optional; stops the passage for later questions)
//
//   ANSWER BANK: a, b, c, d       (optional; for Identification / Fill in the Blanks.
//                                  A list of answers shown to students above every
//                                  question that follows - separate entries with commas
//                                  or "|", or put one per line. Applies until
//                                  END ANSWER BANK, the next ANSWER BANK:, or a new
//                                  COMPETENCY:/TOPIC: line.)
//   END ANSWER BANK               (optional; stops the answer bank for later questions)
//
//   Multiple choice:
//     1. <question text>
//     A. <choice>
//     B. <choice>
//     ...(2-6 lettered choices)
//     ANSWER: <letter>
//
//   Identification (no lettered choices — the line right after the question
//   is read straight as the ANSWER: line):
//     2. <question text>
//     ANSWER: <answer text>
//
//   <blank line between questions — optional, ignored either way>
const mcImportUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// Parses raw extracted .docx text into { items, errors }. items are plain
// { topic, competency, type: "mc", q, choices, correct } or
// { topic, competency, type: "identification", q, answer } objects, NOT yet
// saved — the dashboard shows these as a preview so the teacher can uncheck
// any before they're committed to the item bank via
// /api/import-item-bank-docx/confirm.
function parseMcqTemplateText(rawText) {
  // Word puts every paragraph on its own line and mammoth adds a blank line
  // between paragraphs (so a question, each choice, and the ANSWER line all
  // end up separated by blank lines even though the template shows them
  // back-to-back). Blank lines carry no meaning for parsing either way, so
  // they're dropped up front and the block structure comes entirely from
  // the TOPIC:/COMPETENCY:/number./letter./ANSWER: patterns themselves.
  const lines = rawText.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
  const items = [];
  const errors = [];
  let currentTopic = "General";
  let currentCompetency = "";
  let currentPassage = "";
  let currentBank = "";   // "ANSWER BANK: a | b | c" line, appended to the passage of every item in the group

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!line) { i++; continue; }

    // END ANSWER BANK — stops the answer bank from applying to later questions.
    if (/^END\s+(ANSWER\s+)?BANK\s*:?\s*$/i.test(line)) {
      currentBank = "";
      i++;
      continue;
    }

    // ANSWER BANK: — a list of answers shown to students above every question
    // that follows (Identification / Fill in the Blanks). Entries can be written
    // on one line (separated by commas or "|") or one per line; the list ends at
    // the first numbered question. It applies until END ANSWER BANK, the next
    // ANSWER BANK:, or a new COMPETENCY:/TOPIC: line.
    const bankMatch = line.match(/^ANSWER\s+BANK:\s*(.*)$/i);
    if (bankMatch) {
      const bankLines = [];
      if (bankMatch[1].trim()) bankLines.push(bankMatch[1].trim());
      i++;
      while (i < lines.length &&
             !/^\d+\.\s*\S/.test(lines[i]) &&
             !/^END\s+(PASSAGE|(ANSWER\s+)?BANK)\s*:?\s*$/i.test(lines[i]) &&
             !/^(TOPIC|COMPETENCY|PASSAGE|ANSWER\s+BANK):/i.test(lines[i])) {
        bankLines.push(lines[i]);
        i++;
      }
      let entries;
      if (bankLines.length === 1) {
        entries = bankLines[0].split(bankLines[0].includes("|") ? "|" : ",");
      } else {
        entries = bankLines.flatMap(l => (l.includes("|") ? l.split("|") : [l]));
      }
      entries = entries.map(e => e.trim()).filter(Boolean);
      const seen = new Set();
      entries = entries.filter(e => { const k = e.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
      if (entries.length < 2) {
        currentBank = "";
        errors.push("An ANSWER BANK: line needs at least 2 entries — ignored.");
      } else {
        currentBank = "ANSWER BANK: " + entries.join(" | ");
      }
      continue;
    }

    // END PASSAGE — stops the current passage from applying to later questions.
    if (/^END\s+PASSAGE\s*:?\s*$/i.test(line)) {
      currentPassage = "";
      i++;
      continue;
    }

    // PASSAGE: — the text (one or several lines) runs until the first numbered
    // question (or an END PASSAGE / TOPIC: / COMPETENCY: / PASSAGE: line). It
    // then applies to every question that follows until it is closed.
    const passageMatch = line.match(/^PASSAGE:\s*(.*)$/i);
    if (passageMatch) {
      const parts = [];
      if (passageMatch[1].trim()) parts.push(passageMatch[1].trim());
      i++;
      while (i < lines.length &&
             !/^\d+\.\s*\S/.test(lines[i]) &&
             !/^END\s+PASSAGE\s*:?\s*$/i.test(lines[i]) &&
             !/^(TOPIC|COMPETENCY|PASSAGE|ANSWER\s+BANK):/i.test(lines[i])) {
        parts.push(lines[i]);
        i++;
      }
      currentPassage = parts.join("\n");
      if (!currentPassage) {
        errors.push("A PASSAGE: line has no text after it — ignored.");
      }
      continue;
    }

    const topicMatch = line.match(/^TOPIC:\s*(.+)$/i);
    if (topicMatch) {
      currentTopic = topicMatch[1].trim() || "General";
      currentCompetency = ""; // a new topic starts without a competency until one is given
      currentPassage = "";    // ...and without a passage
      currentBank = "";       // ...or an answer bank
      i++;
      continue;
    }

    const competencyMatch = line.match(/^COMPETENCY:\s*(.*)$/i);
    if (competencyMatch) {
      currentCompetency = competencyMatch[1].trim();
      currentPassage = "";    // a new competency starts a new group of questions
      currentBank = "";
      i++;
      continue;
    }

    const qMatch = line.match(/^(\d+)\.\s*(.+)$/);
    if (qMatch) {
      const qNum = qMatch[1];
      const qText = qMatch[2].trim();
      i++;

      const choices = [];
      while (i < lines.length && /^[A-F][.)]\s*/.test(lines[i])) {
        const cm = lines[i].match(/^([A-F])[.)]\s*(.*)$/);
        choices.push({ letter: cm[1], text: cm[2].trim() });
        i++;
      }

      // No lettered choices were found, so this is an Identification item:
      // the ANSWER: line carries the free-text answer instead of a letter.
      if (choices.length === 0) {
        let answerText = null;
        if (i < lines.length && /^ANSWER:\s*/i.test(lines[i])) {
          const am = lines[i].match(/^ANSWER:\s*(.+)$/i);
          answerText = am ? am[1].trim() : null;
          i++;
        }

        if (!qText) {
          errors.push(`Question ${qNum}: empty question text — skipped.`);
          continue;
        }
        if (!answerText) {
          errors.push(`Question ${qNum}: missing or empty ANSWER: line — skipped.`);
          continue;
        }

        items.push({
          topic: currentTopic,
          competency: currentCompetency,
          passage: [currentPassage, currentBank].filter(Boolean).join("\n"),
          type: "identification",
          q: qText,
          answer: answerText,
        });
        continue;
      }

      // Otherwise it's Multiple Choice.
      let correctLetter = null;
      if (i < lines.length && /^ANSWER:\s*/i.test(lines[i])) {
        const am = lines[i].match(/^ANSWER:\s*([A-F])/i);
        correctLetter = am ? am[1].toUpperCase() : null;
        i++;
      }

      if (!qText) {
        errors.push(`Question ${qNum}: empty question text — skipped.`);
        continue;
      }
      if (choices.length < 2 || choices.length > 6 || choices.some(c => !c.text)) {
        errors.push(`Question ${qNum}: needs 2-6 non-empty lettered choices — skipped.`);
        continue;
      }
      if (!correctLetter) {
        errors.push(`Question ${qNum}: missing or unreadable ANSWER: line — skipped.`);
        continue;
      }
      const correctIdx = choices.findIndex(c => c.letter === correctLetter);
      if (correctIdx === -1) {
        errors.push(`Question ${qNum}: ANSWER: ${correctLetter} does not match any listed choice — skipped.`);
        continue;
      }

      items.push({
        topic: currentTopic,
        competency: currentCompetency,
        passage: [currentPassage, currentBank].filter(Boolean).join("\n"),
        type: "mc",
        q: qText,
        choices: choices.map(c => c.text),
        correct: correctIdx,
      });
      continue;
    }

    // Any other non-blank line outside a recognized block is ignored (e.g.
    // stray instructions left over from the template) rather than aborting
    // the whole import.
    i++;
  }

  return { items, errors };
}

// Step 1: upload the .docx, get back a preview (nothing is saved yet).
app.post("/api/import-item-bank-docx", mcImportUpload.single("file"), async (req, res) => {
  if ((req.body?.password ?? "") !== RESET_PASSWORD) {
    return res.status(401).json({ ok: false, message: "Incorrect password." });
  }
  if (!req.file) {
    return res.status(400).json({ ok: false, message: "No file uploaded." });
  }
  try {
    const { value: rawText } = await mammoth.extractRawText({ buffer: req.file.buffer });
    const { items, errors } = parseMcqTemplateText(rawText);
    res.json({ ok: true, items, errors });
  } catch (err) {
    console.error("Item bank .docx import failed:", err);
    res.status(500).json({ ok: false, message: "Could not read that file. Make sure it's a .docx, not .doc." });
  }
});

// Step 2: teacher has reviewed the preview (possibly excluding some rows) in
// the dashboard; commit the approved items to the item bank.
app.post("/api/import-item-bank-docx/confirm", (req, res) => {
  const { password, items } = req.body || {};
  if ((password ?? "") !== RESET_PASSWORD) {
    return res.status(401).json({ ok: false, message: "Incorrect password." });
  }
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ ok: false, message: "No items to import." });
  }

  let added = 0;
  const rejected = [];
  const batchCreatedAt = new Date().toISOString(); // one timestamp for the whole upload
  for (const raw of items) {
    const topicText = (typeof raw?.topic === "string" ? raw.topic.trim() : "") || "General";
    const competencyText = typeof raw?.competency === "string" ? raw.competency.trim() : "";
    const passageText = cleanPassage(raw?.passage);
    const text = typeof raw?.q === "string" ? raw.q.trim() : "";
    const itemType = raw?.type === "identification" ? "identification" : "mc";

    if (itemType === "identification") {
      const answerText = typeof raw?.answer === "string" ? raw.answer.trim() : "";
      if (!text || !answerText) {
        rejected.push(text || "(blank question)");
        continue;
      }
      itemBank.push({
        id: `ib_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        topic: topicText,
        competency: competencyText,
        passage: passageText,
        type: "identification",
        q: text,
        answer: answerText,
        createdAt: batchCreatedAt,
      });
      added++;
      continue;
    }

    const cleanChoices = Array.isArray(raw?.choices)
      ? raw.choices.map(c => (typeof c === "string" ? c.trim() : "")).filter(c => c.length > 0)
      : [];
    const correctIdx = Number(raw?.correct);

    if (!text || cleanChoices.length < 2 || cleanChoices.length > 6 ||
        !Number.isInteger(correctIdx) || correctIdx < 0 || correctIdx >= cleanChoices.length) {
      rejected.push(text || "(blank question)");
      continue;
    }

    itemBank.push({
      id: `ib_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      topic: topicText,
      competency: competencyText,
      passage: passageText,
      type: "mc",
      q: text,
      choices: cleanChoices,
      correct: correctIdx,
      createdAt: batchCreatedAt,
    });
    added++;
  }

  if (added > 0) {
    saveItemBank();
    console.log(`🗃  Item bank: imported ${added} item(s) from .docx (${rejected.length} rejected)`);
  }
  res.json({ ok: true, added, rejected, total: itemBank.length });
});

app.get("/",          (_, res) => res.sendFile(path.join(__dirname, "public/index.html")));
app.get("/dashboard", (_, res) => res.sendFile(path.join(__dirname, "public/dashboard.html")));
app.get("/health",    (_, res) => res.json({ ok: true, submissions: submissions.length }));

// Save button in the teacher app: flush everything to disk right now.
// Loopback only, so a student on the Wi-Fi can never trigger it.
app.post("/api/save-now", (req, res) => {
  const a = req.socket.remoteAddress || "";
  if (!(a === "127.0.0.1" || a === "::1" || a === "::ffff:127.0.0.1")) {
    return res.status(403).json({ ok: false, message: "Only the teacher computer can do this." });
  }
  const failed = flushAll();
  res.json({ ok: failed.length === 0, failed, savedAt: new Date().toISOString() });
});

// Ordered list of section names used to build the login dropdown, in
// Grade 7 → Grade 10 order (not alphabetical), derived from GRADE_STRUCTURE.
const SECTION_ORDER = Object.values(GRADE_STRUCTURE).flat();

// Lets the student login page fetch the current grade/section/subject
// structure instead of hardcoding it, so GRADE_STRUCTURE/SUBJECTS above stay
// the single source of truth.
app.get("/api/structure", (_, res) => {
  res.json({ subjects: SUBJECTS, grades: GRADE_STRUCTURE });
});

// Build the roster, excluding students who have already been "picked" —
// i.e. anyone currently logged in (active session) or who has already
// submitted. Once picked, a name is removed for every connected client
// until an admin reset or kick frees it up again.
function getAvailableRoster() {
  // A student with an unfinished session whose connection dropped stays
  // selectable, so they can log in from another laptop and resume.
  const usedIds = new Set([
    ...[...activeSessions.entries()].filter(([, v]) => v.status !== "disconnected").map(([id]) => id),
    ...submissions.map(s => s.studentId),
  ]);

  const bySection = new Map();
  for (const s of studentList) {
    if (usedIds.has(s.id)) continue;
    // Hide the section entirely once every one of its subjects is disabled;
    // otherwise keep it (its subject dropdown is trimmed via
    // enabledSubjects below, so a disabled subject still can't be picked).
    if (!sectionHasAnyEnabledSubject(s.section)) continue;
    if (!bySection.has(s.section)) bySection.set(s.section, []);
    bySection.get(s.section).push(s.name);
  }

  // Sections in the preferred order first, then any others found in the
  // data (e.g. if the roster is edited later) appended alphabetically.
  const orderedSections = [
    ...SECTION_ORDER.filter(sec => bySection.has(sec)),
    ...[...bySection.keys()].filter(sec => !SECTION_ORDER.includes(sec)).sort(),
  ];

  return orderedSections.map(section => ({
    section,
    names: (bySection.get(section) || []).slice().sort((a, b) => a.localeCompare(b)),
    enabledSubjects: enabledSubjectsForSection(section),
  }));
}

// Push the latest roster to every connected client in real time, so a name
// disappears from everyone's dropdown the instant it's picked (and
// reappears if an admin resets or kicks that student).
function broadcastRoster() {
  io.emit("roster-update", getAvailableRoster());
}

app.get("/api/roster", (_, res) => {
  res.json(getAvailableRoster());
});

// ── CSV helpers (shared by live export and archive export) ──────────────────
function gradeFromPct(pct) {
  if (pct >= 90) return "A";
  if (pct >= 80) return "B";
  if (pct >= 70) return "C";
  if (pct >= 60) return "D";
  return "F";
}

function submissionsToCsv(subs) {
  const headers = [
    "Student ID","Name","Section","Score","Total Points","Percentage",
    "Grade","Tab Switches","Paste Flags","Auto Submitted",
    "Duration (s)","Timestamp"
  ];

  const rows = subs.map(s => [
    s.studentId,
    `"${(s.name || "").replace(/"/g, '""')}"`,
    `"${(s.gradeSection || "").replace(/"/g, '""')}"`,
    s.score,
    s.maxScore ?? s.totalItems,
    s.percentage,
    gradeFromPct(s.percentage),
    s.tabSwitches ?? 0,
    s.pasteFlags ?? 0,
    s.autoSubmitted ? "YES" : "NO",
    Math.round((s.durationMs || 0) / 1000),
    s.timestamp,
  ]);

  return [headers.join(","), ...rows.map(r => r.join(","))].join("\n");
}

// ── CSV Export endpoint ──────────────────────────────────────────────────────
app.get("/export-csv", (req, res) => {
  const { password } = req.query;
  if (password !== RESET_PASSWORD) {
    return res.status(401).json({ error: "Incorrect password." });
  }

  const csv = submissionsToCsv(submissions);
  const filename = `quiz_results_${new Date().toISOString().slice(0,10)}.csv`;

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

// ── Archive CSV Export endpoint ──────────────────────────────────────────────
app.get("/export-archive-csv", (req, res) => {
  const { password, id } = req.query;
  if (password !== RESET_PASSWORD) {
    return res.status(401).json({ error: "Incorrect password." });
  }

  const entry = quizArchive.find(a => a.id === id);
  if (!entry) return res.status(404).json({ error: "Archive not found." });

  const csv = submissionsToCsv(entry.submissions);
  const safeName = (entry.name || "exam").replace(/[^a-z0-9_\-]+/gi, "_");
  const filename = `${safeName}_${entry.archivedAt.slice(0, 10)}.csv`;

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

// ── Student Scores report (Quiz / Summative / Term Exam, per student, per section) ─
// Pulls from the permanent quizArchive (every exam ever archived), not the live
// "submissions" array, so this stays complete across resets. Every student in
// students.json is seeded into the report (even with zero exams taken yet);
// any submission for a studentId not found in the roster is still included
// under whatever section/name was recorded on the submission itself.
//
// Unlike an averaged summary, this is a class-record layout: every archived
// exam becomes its own column (grouped under Quiz / Summative / Term Exam),
// so a teacher can see each individual score, not just a combined average.
function categoryForExamType(examType) {
  if (examType === "Summative Test") return "summative";
  if (examType === "Term Examination") return "term";
  return "quiz";
}

// Names are stored "First [Middle...] Last" (e.g. "CHARLES GABRIEL LAMERA"),
// so the surname is the final whitespace-separated token.
function surnameOf(name) {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}

function buildStudentScoresReport() {
  // Roster lookup for gender — submissions themselves don't carry gender,
  // so any studentId not found here (e.g. an old submission for someone no
  // longer on the roster) falls back to "—" rather than guessing.
  const genderById = new Map(studentList.map(s => [s.id, s.gender || "—"]));

  const byId = new Map();
  const ensure = (id, name, section) => {
    if (!byId.has(id)) {
      byId.set(id, { id, name, section: section || "—", gender: genderById.get(id) || "—", scores: {} });
    }
    return byId.get(id);
  };

  // Seed every enrolled student first, so students with no submissions yet
  // still show up on the report.
  studentList.forEach(s => ensure(s.id, s.name, sectionKey(s.section)));

  // One column per archived exam, in the order they were given.
  const exams = quizArchive
    .slice()
    .sort((a, b) => new Date(a.archivedAt) - new Date(b.archivedAt))
    .map(entry => ({
      id: entry.id,
      name: entry.name,
      examType: entry.examType || "Quiz",
      category: categoryForExamType(entry.examType || "Quiz"),
      archivedAt: entry.archivedAt,
      maxScore: entry.maxScore,
      sections: Array.from(new Set((entry.submissions || []).map(sub => sub.gradeSection).filter(Boolean))),
    }));

  // Fold in every archived exam's individual submissions as one score per column.
  quizArchive.forEach(entry => {
    (entry.submissions || []).forEach(sub => {
      const rec = ensure(sub.studentId, sub.name, sub.gradeSection);
      // A submission's section can be more up to date than a stale roster
      // entry (e.g. a section rename) — prefer it when present.
      if (sub.gradeSection) rec.section = sub.gradeSection;
      rec.scores[entry.id] = {
        score: sub.score ?? 0,
        max: sub.maxScore ?? sub.totalItems ?? entry.maxScore ?? 0,
        percentage: sub.percentage ?? null,
        // The section/subject THIS submission was actually taken under —
        // needed so a section-filtered view only shows scores that really
        // belong to it. (rec.section above is last-write-wins across every
        // exam a student has, so it can't be used to gate individual
        // score cells — a student who takes both a Math and a Science
        // quiz would otherwise leak one subject's score into the other's
        // filtered report.)
        section: sub.gradeSection || null,
      };
    });
  });

  const students = Array.from(byId.values()).sort((a, b) => {
    const secCmp = (a.section || "").localeCompare(b.section || "");
    if (secCmp !== 0) return secCmp;
    // Alphabetical by surname (last name), not first name.
    const surCmp = surnameOf(a.name).localeCompare(surnameOf(b.name));
    if (surCmp !== 0) return surCmp;
    return (a.name || "").localeCompare(b.name || "");
  });

  return { exams, students };
}

function studentScoresToCsv(exams, students) {
  const headers = [
    "Student ID", "Name", "Gender", "Section",
    ...exams.map(e => `${e.name} (${e.examType})`),
  ];
  const csvRows = students.map(s => [
    s.id,
    `"${(s.name || "").replace(/"/g, '""')}"`,
    `"${(s.gender || "—").replace(/"/g, '""')}"`,
    `"${(s.section || "").replace(/"/g, '""')}"`,
    ...exams.map(e => {
      const cell = s.scores[e.id];
      return cell ? `${cell.score}/${cell.max}` : "";
    }),
  ]);

  // Append a per-section MPS (Mean Percentage Score) row for every section
  // present among the exported students — mirrors the on-screen report.
  // Computed live from each score cell's own recorded section, since an
  // "All Sections" archive entry only stores one blended average, not a
  // per-section breakdown.
  const sectionsInOrder = [];
  students.forEach(s => {
    if (!sectionsInOrder.includes(s.section)) sectionsInOrder.push(s.section);
  });
  const mpsRows = sectionsInOrder.map(section => {
    const groupStudents = students.filter(s => s.section === section);
    const mpsCells = exams.map(e => {
      const vals = groupStudents
        .map(s => s.scores[e.id])
        .filter(c => c && c.section === section && c.percentage != null);
      if (!vals.length) return "";
      const avg = vals.reduce((a, c) => a + c.percentage, 0) / vals.length;
      return `${avg.toFixed(1)}% (n=${vals.length})`;
    });
    return [
      "", `"MPS — ${(section || "").replace(/"/g, '""')}"`, "", "",
      ...mpsCells,
    ];
  });

  return [headers.join(","), ...csvRows.map(r => r.join(",")), ...mpsRows.map(r => r.join(","))].join("\n");
}

// ── Student Scores CSV Export endpoint ───────────────────────────────────────
app.get("/export-student-scores-csv", (req, res) => {
  const { password, section } = req.query;
  if (password !== RESET_PASSWORD) {
    return res.status(401).json({ error: "Incorrect password." });
  }
  const { exams, students } = buildStudentScoresReport();

  // A section-scoped export must only include scores actually earned under
  // that section/subject — a student's overall `section` is last-write-wins
  // across every exam they've taken, so it can't gate this by itself (see
  // buildStudentScoresReport). Filter both which students appear AND which
  // of their score cells are kept by each cell's own recorded section.
  const filteredStudents = (section && section !== "ALL")
    ? students
        .filter(s => Object.values(s.scores).some(c => c.section === section))
        .map(s => ({
          ...s,
          scores: Object.fromEntries(Object.entries(s.scores).filter(([, c]) => c.section === section)),
        }))
    // "All Sections" mirrors the on-screen report: subject-sections that
    // aren't currently enabled are left out of the export too.
    : students.filter(s => ENABLED_SECTIONS.includes(s.section));

  // Only include exam columns that at least one of the filtered students
  // actually has a score for, so a section-scoped export isn't full of
  // blank columns from exams given to other sections.
  const filteredExams = exams.filter(e => filteredStudents.some(s => s.scores[e.id]));

  const csv = studentScoresToCsv(filteredExams, filteredStudents);
  const filename = `student_scores_${section && section !== "ALL" ? section.replace(/[^a-z0-9_\-]+/gi, "_") + "_" : ""}${new Date().toISOString().slice(0, 10)}.csv`;

  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csv);
});

// ── Rate-limit helper ────────────────────────────────────────────────────────
function isRateLimited(socketId) {
  const now = Date.now();
  const record = loginAttempts.get(socketId) || { count: 0, windowStart: now };

  if (now - record.windowStart > RATE_LIMIT_WINDOW_MS) {
    record.count = 0;
    record.windowStart = now;
  }

  if (record.count >= MAX_LOGIN_ATTEMPTS) {
    loginAttempts.set(socketId, record);
    return true;
  }

  record.count++;
  loginAttempts.set(socketId, record);
  return false;
}

// ── Broadcast active sessions to all dashboard listeners ────────────────────
function broadcastActiveSessions() {
  const sessions = Array.from(activeSessions.values());
  io.emit("active-sessions-update", sessions);
}

// ── Build a fresh, per-student quiz payload (shared by login & guest-login) ──
// Shuffles the live question set (and, for MC items, their choices), and
// builds the server-side-only answer key. Identification items are never
// sent their answer text — only MC items get `choices` on the client copy,
// and the correct-answer text for identification items is stored in
// `correctAnswers` as a normalized (trimmed/collapsed-whitespace/lowercased)
// string for case-insensitive grading at submit time.
function buildQuizPayload(exam) {
  // Per-student order: grouped into fixed type blocks (all Multiple Choice,
  // then all Identification, then all Matching) — shuffled only within each
  // block, so a student never sees types interleaved.
  const shuffledQuestions = groupByTypeThenShuffle(exam.questions);
  const pointsSnapshot = {};
  shuffledQuestions.forEach(q => { pointsSnapshot[q.num] = getPoints(q.num, exam); });
  const maxScore = Object.values(pointsSnapshot).reduce((a, b) => a + b, 0);

  const questionDataForClient = shuffledQuestions.map(q => {
    const itemType = normalizeItemType(q.type);
    if (itemType === "identification") {
      return { num: q.num, type: itemType, q: q.q, passage: q.passage || "", image: q.image || "", points: pointsSnapshot[q.num] };
    }
    if (itemType === "matching") {
      // Left-side prompts go out in their original (unshuffled) order so
      // numbering stays stable; only the right-side option pool is shuffled.
      const leftItems = q.pairs.map(p => p.left);
      const options = shuffle(q.pairs.map(p => p.right));
      return { num: q.num, type: itemType, q: q.q, passage: q.passage || "", image: q.image || "", leftItems, options, points: pointsSnapshot[q.num] };
    }
    const shuffledChoices = shuffle(q.choices);
    return { num: q.num, type: itemType, q: q.q, passage: q.passage || "", image: q.image || "", choices: shuffledChoices, points: pointsSnapshot[q.num] };
  });

  const correctAnswers = {};
  shuffledQuestions.forEach((origQ, clientIndex) => {
    const itemType = normalizeItemType(origQ.type);
    if (itemType === "identification") {
      correctAnswers[origQ.num] = normalizeIdentificationAnswer(origQ.answer);
    } else if (itemType === "matching") {
      // Array aligned to leftItems: correctAnswers[num][i] = index into the
      // shuffled `options` array that correctly matches leftItems[i].
      const clientOptions = questionDataForClient[clientIndex].options;
      correctAnswers[origQ.num] = origQ.pairs.map(p => clientOptions.indexOf(p.right));
    } else {
      const correctText = origQ.choices[origQ.correct];
      correctAnswers[origQ.num] = questionDataForClient[clientIndex].choices.indexOf(correctText);
    }
  });

  return { shuffledQuestions, questionDataForClient, correctAnswers, pointsSnapshot, maxScore };
}

// ── Socket.IO ────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  const clientIp = socket.handshake.headers["x-forwarded-for"] || socket.handshake.address;
  console.log(`🔌 Client connected | socket=${socket.id} | ip=${clientIp}`);

  socket.emit("quiz-update", getCurrentState());
  socket.emit("active-sessions-update", Array.from(activeSessions.values()));
  socket.emit("exam-status-map", { statuses: examStatusMap() });
  socket.emit("results-status", { visible: resultsVisible });
  socket.emit("roster-update", getAvailableRoster());
  socket.emit("enabled-sections-update", ENABLED_SECTIONS);

  // ── Login ─────────────────────────────────────────────────────────────────
  socket.on("student-login", ({ section, name, subject } = {}) => {
    if (!section || !name) {
      return socket.emit("login-failed", { message: "Please select both your section and your name." });
    }

    if (isRateLimited(socket.id)) {
      return socket.emit("login-failed", { message: "Too many login attempts. Please wait a moment." });
    }

    const normalizedSection = String(section).trim().toUpperCase();
    const normalizedName    = String(name).trim().toUpperCase();

    const student = studentList.find(
      s => s.section === normalizedSection && s.name === normalizedName
    );

    if (!student) {
      return socket.emit("login-failed", { message: "We couldn't find that name in the selected section." });
    }

    if (sectionRequiresSubject(student.section) && !subject) {
      return socket.emit("login-failed", { message: "Please select your subject." });
    }

    // Resolve this student's section-subject key first: each key has its own
    // exam, so the open/locked check below is per key, not global.
    const gradeKey = sectionKey(student.section, subject);
    if (!gradeKey) {
      return socket.emit("login-failed", { message: "That subject isn't valid for your section. Please select your subject again." });
    }
    const exam = getExam(gradeKey);

    if (!exam.open) {
      return socket.emit("login-failed", { message: "⏳ This exam is not open yet. Please wait for your teacher to start it." });
    }

    if (submissions.some(s => s.studentId === student.id)) {
      return socket.emit("login-failed", { message: "You have already submitted this quiz." });
    }

    for (const [, otherSocket] of io.sockets.sockets) {
      if (otherSocket.id !== socket.id &&
          otherSocket.studentData?.id === student.id &&
          !otherSocket.studentData?.submitted) {
        return socket.emit("login-failed", { message: "Another session is already active for this account." });
      }
    }

    // Unfinished session from an earlier connection (other laptop, crash,
    // dead WiFi)? Continue it instead of starting a fresh attempt.
    const existingSd = studentSessions.get(student.id);
    if (existingSd && !existingSd.submitted) {
      const exDur = existingSd.durationMs ?? getExamDurationMs(exam);
      if (Date.now() - existingSd.startTime <= exDur + GRACE_PERIOD_MS) {
        loginAttempts.delete(socket.id);
        return resumeSession(student.id);
      }
      studentSessions.delete(student.id);
    }

    const { shuffledQuestions, questionDataForClient, correctAnswers, pointsSnapshot, maxScore } = buildQuizPayload(exam);

    // Per-subject gate: even if a raw section has other subjects open, this
    // specific subject-section must be individually enabled. Checked here
    // (not earlier) so it applies even if someone bypasses the client and
    // emits student-login directly with an arbitrary section/subject pair.
    if (!ENABLED_SECTIONS.includes(gradeKey)) {
      return socket.emit("login-failed", { message: "This subject isn't currently active for your section. Please contact your teacher." });
    }

    loginAttempts.delete(socket.id);

    const n = shuffledQuestions.length;
    socket.studentData = {
      id:                   student.id,
      name:                 student.name,
      section:              gradeKey,
      examType:             exam.examType,
      startTime:            Date.now(),
      durationMs:           getExamDurationMs(exam),
      shuffledQuestions,
      questionDataForClient,
      correctAnswers,
      pointsSnapshot,
      maxScore,
      submitted:            false,
      tabSwitches:          0,
      pasteFlags:           0,
      autoSubmitted:        false,
      paused:               false,
      itemTimeMs:           new Array(n).fill(0),
      itemViewStart:        new Array(n).fill(null),
      answerChanges:        new Array(n).fill(0),
    };

    studentSessions.set(student.id, socket.studentData);
    saveInProgressSessions();

    activeSessions.set(student.id, {
      studentId:     student.id,
      name:          student.name,
      section:       gradeKey,
      answeredCount: 0,
      totalItems:    n,
      tabSwitches:   0,
      pasteFlags:    0,
      startTime:     socket.studentData.startTime,
      socketId:      socket.id,
      status:        "active",
      paused:        false,
    });

    broadcastActiveSessions();
    broadcastRoster();

    console.log(`✅ Login: ${student.name} (${student.id}) | Section: ${gradeKey}`);

    socket.emit("login-success", {
      studentId:    student.id,
      name:         student.name,
      gradeSection: gradeKey,
      examType:     exam.examType,
      questions:    questionDataForClient,
      totalItems:   n,
      maxScore,
      durationMs:   socket.studentData.durationMs,
      history:      getStudentHistory(student.id),
    });
  });

  // ── Guest Login (for practice/review sessions — no roster check) ───────────
  socket.on("guest-login", ({ name } = {}) => {
    if (!name || !String(name).trim()) {
      return socket.emit("login-failed", { message: "Please enter your name." });
    }

    if (isRateLimited(socket.id)) {
      return socket.emit("login-failed", { message: "Too many login attempts. Please wait a moment." });
    }

    const cleanName = String(name).trim().slice(0, 60);
    const guestId = `GUEST-${Date.now()}-${Math.floor(Math.random() * 10000)}`;

    // Guests have no section: give them the first open exam, else a practice
    // exam built from the seed question set.
    const guestExam = Array.from(examsByKey.values()).find(e => e.open) || getExam("__PRACTICE__");
    const { shuffledQuestions, questionDataForClient, correctAnswers, pointsSnapshot, maxScore } = buildQuizPayload(guestExam);

    loginAttempts.delete(socket.id);

    const n = shuffledQuestions.length;
    socket.studentData = {
      id:                   guestId,
      name:                 cleanName,
      section:              "GUEST",
      isGuest:              true,
      examType:             guestExam.examType,
      startTime:            Date.now(),
      durationMs:           getExamDurationMs(guestExam),
      shuffledQuestions,
      questionDataForClient,
      correctAnswers,
      pointsSnapshot,
      maxScore,
      submitted:            false,
      tabSwitches:          0,
      pasteFlags:           0,
      autoSubmitted:        false,
      paused:               false,
      itemTimeMs:           new Array(n).fill(0),
      itemViewStart:        new Array(n).fill(null),
      answerChanges:        new Array(n).fill(0),
    };

    studentSessions.set(guestId, socket.studentData);
    saveInProgressSessions();

    activeSessions.set(guestId, {
      studentId:     guestId,
      name:          cleanName,
      section:       "GUEST",
      answeredCount: 0,
      totalItems:    n,
      tabSwitches:   0,
      pasteFlags:    0,
      startTime:     socket.studentData.startTime,
      socketId:      socket.id,
      status:        "active",
      isGuest:       true,
      paused:        false,
    });

    broadcastActiveSessions();

    console.log(`👤 Guest login: ${cleanName} (${guestId})`);

    socket.emit("login-success", {
      studentId:    guestId,
      name:         cleanName,
      gradeSection: "GUEST",
      examType:     guestExam.examType,
      questions:    questionDataForClient,
      totalItems:   n,
      maxScore,
      durationMs:   socket.studentData.durationMs,
      isGuest:      true,
    });
  });

  // ── Resume session (browser closed/refreshed, tab crashed, WiFi drop) ──────
  // The client fires this on every connect, passing back whatever studentId
  // it has cached in localStorage. We rebind the fresh socket to the existing
  // in-progress session (same shuffled questions, same start time, answers
  // the client already has saved locally) instead of starting over.
  function resumeSession(resumeId) {
    if (!resumeId) return;

    // Already graded and recorded server-side — nothing left to resume.
    if (submissions.some(s => s.studentId === resumeId)) {
      studentSessions.delete(resumeId);
      return socket.emit("resume-failed", { alreadySubmitted: true });
    }

    const sd = studentSessions.get(resumeId);
    if (!sd) {
      // No known in-progress session — server restarted long ago, admin reset
      // the quiz, or this is a stale/unrelated resume key. Send them to a
      // normal login instead of erroring.
      return socket.emit("resume-failed", {});
    }

    const sessionDurationMs = sd.durationMs ?? getQuizDurationMs();
    const elapsed = Date.now() - sd.startTime;
    if (elapsed > sessionDurationMs + GRACE_PERIOD_MS) {
      studentSessions.delete(resumeId);
      if (activeSessions.has(resumeId)) {
        activeSessions.delete(resumeId);
        broadcastActiveSessions();
        broadcastRoster();
      }
      saveInProgressSessions();
      return socket.emit("resume-failed", { expired: true });
    }

    // If another tab/device is still holding this session, the newly
    // reconnecting one wins (mirrors the single-session rule used at login).
    for (const [, otherSocket] of io.sockets.sockets) {
      if (otherSocket.id !== socket.id && otherSocket.studentData?.id === resumeId) {
        otherSocket.emit("kicked", { message: "You reconnected from another tab or device." });
        otherSocket.disconnect(true);
      }
    }

    socket.studentData = sd;

    const remainingMs = Math.max(0, sessionDurationMs - elapsed);

    const resumedAnswered = Array.isArray(sd.savedAnswers)
      ? sd.savedAnswers.filter(a => Array.isArray(a) ? a.length > 0 && a.every(v => v !== -1) : (typeof a === "string" ? a.trim().length > 0 : a !== -1)).length
      : 0;

    if (activeSessions.has(resumeId)) {
      const sess = activeSessions.get(resumeId);
      sess.socketId = socket.id;
      sess.status   = "active";
      if (resumedAnswered > sess.answeredCount) sess.answeredCount = resumedAnswered;
    } else {
      activeSessions.set(resumeId, {
        studentId:     resumeId,
        name:          sd.name,
        section:       sd.section,
        answeredCount: resumedAnswered,
        totalItems:    sd.shuffledQuestions.length,
        tabSwitches:   sd.tabSwitches,
        pasteFlags:    sd.pasteFlags,
        startTime:     sd.startTime,
        socketId:      socket.id,
        status:        "active",
        isGuest:       !!sd.isGuest,
        paused:        !!sd.paused,
      });
    }
    broadcastActiveSessions();
    broadcastRoster();

    console.log(`🔄 Resumed session: ${sd.name} (${resumeId}) | Remaining: ${Math.round(remainingMs / 1000)}s`);

    socket.emit("resume-success", {
      studentId:    resumeId,
      name:         sd.name,
      gradeSection: sd.section,
      examType:     sd.examType || (examsByKey.get(sd.section) || {}).examType || "Quiz",
      questions:    sd.questionDataForClient,
      totalItems:   sd.shuffledQuestions.length,
      maxScore:     sd.maxScore,
      remainingMs,
      tabSwitches:  sd.tabSwitches,
      isGuest:      !!sd.isGuest,
      paused:       !!sd.paused,
      history:      sd.isGuest ? [] : getStudentHistory(resumeId),
      answers:      Array.isArray(sd.savedAnswers) ? sd.savedAnswers : null,
      flagged:      Array.isArray(sd.savedFlagged) ? sd.savedFlagged : [],
    });
  }
  socket.on("resume-session", ({ studentId } = {}) => resumeSession(studentId));

  // ── Save answers server-side so they follow the student to any device ──────
  function sanitizeAnswers(sd, answers) {
    const qs = sd.shuffledQuestions;
    if (!Array.isArray(answers) || answers.length !== qs.length) return null;
    const out = [];
    for (let i = 0; i < qs.length; i++) {
      const type = normalizeItemType(qs[i] && qs[i].type);
      const a = answers[i];
      if (type === "identification") {
        if (typeof a !== "string") return null;
        out.push(a.slice(0, 500));
      } else if (type === "matching") {
        const pc = Array.isArray(qs[i].pairs) ? qs[i].pairs.length : 0;
        const ok = Array.isArray(a) && a.length === pc &&
          a.every(v => Number.isInteger(v) && (v === -1 || (v >= 0 && v < pc)));
        if (!ok) return null;
        out.push(a.slice());
      } else {
        if (!Number.isInteger(a) || a < -1 || a > 3) return null;
        out.push(a);
      }
    }
    return out;
  }

  socket.on("save-progress", ({ answers, flagged } = {}, ack) => {
    const reply = (ok) => { if (typeof ack === "function") ack({ ok }); };
    const sd = socket.studentData;
    if (!sd || sd.submitted || sd.paused) return reply(false);
    const dur = sd.durationMs ?? getQuizDurationMs();
    if (Date.now() - sd.startTime > dur + GRACE_PERIOD_MS) return reply(false);

    const clean = sanitizeAnswers(sd, answers);
    if (!clean) return reply(false);

    const n = sd.shuffledQuestions.length;
    const cleanFlags = Array.isArray(flagged)
      ? [...new Set(flagged.filter(i => Number.isInteger(i) && i >= 0 && i < n))]
      : [];

    sd.savedAnswers    = clean;
    sd.savedFlagged    = cleanFlags;
    sd.progressSavedAt = Date.now();
    scheduleSaveInProgress();
    reply(true);
  });

  // ── Per-item time tracking ────────────────────────────────────────────────
  socket.on("item-view", ({ itemIndex } = {}) => {
    if (!socket.studentData || socket.studentData.submitted || socket.studentData.paused) return;
    const sd = socket.studentData;
    const n  = sd.shuffledQuestions.length;
    if (typeof itemIndex !== "number" || itemIndex < 0 || itemIndex >= n) return;

    const now = Date.now();

    // Close out any previously open item
    for (let i = 0; i < n; i++) {
      if (sd.itemViewStart[i] !== null && i !== itemIndex) {
        sd.itemTimeMs[i] += now - sd.itemViewStart[i];
        sd.itemViewStart[i] = null;
      }
    }

    sd.itemViewStart[itemIndex] = now;
  });

  // ── Answer change tracking ────────────────────────────────────────────────
  socket.on("answer-changed", ({ itemIndex } = {}) => {
    if (!socket.studentData || socket.studentData.submitted || socket.studentData.paused) return;
    const sd = socket.studentData;
    if (typeof itemIndex !== "number" || itemIndex < 0 || itemIndex >= sd.shuffledQuestions.length) return;
    sd.answerChanges[itemIndex]++;
  });

  // ── Live answered count update from client ────────────────────────────────
  socket.on("answered-count", ({ count } = {}) => {
    if (!socket.studentData || socket.studentData.submitted || socket.studentData.paused) return;
    if (activeSessions.has(socket.studentData.id)) {
      activeSessions.get(socket.studentData.id).answeredCount = typeof count === "number" ? count : 0;
      broadcastActiveSessions();
    }
  });

  // ── Paste detection ───────────────────────────────────────────────────────
  socket.on("paste-detected", () => {
    if (!socket.studentData || socket.studentData.submitted) return;
    const sd = socket.studentData;
    sd.pasteFlags++;

    if (activeSessions.has(sd.id)) {
      activeSessions.get(sd.id).pasteFlags = sd.pasteFlags;
      broadcastActiveSessions();
    }

    console.log(`📋 Paste detected | ${sd.name} (${sd.id}) | Total: ${sd.pasteFlags}`);

    io.emit("integrity-event", {
      type:      "paste",
      studentId: sd.id,
      name:      sd.name,
      section:   sd.section,
      count:     sd.pasteFlags,
      timestamp: new Date().toISOString(),
    });
  });

  // ── Submit quiz ───────────────────────────────────────────────────────────
  socket.on("submit-quiz", (data = {}) => {
    const { studentId, name, gradeSection, selectedAnswers, totalItems } = data;

    // Self-heal: after a dropped connection the new socket may not be bound to
    // the student yet (resume hasn't run or failed). If the server still holds
    // this student's saved in-progress session, re-attach it instead of
    // rejecting the submission.
    if ((!socket.studentData || socket.studentData.id !== studentId) && studentId) {
      const savedSd = studentSessions.get(studentId);
      const alreadyGraded = submissions.some(s => s.studentId === studentId);
      if (savedSd && !savedSd.submitted && !alreadyGraded) {
        for (const [, otherSocket] of io.sockets.sockets) {
          if (otherSocket.id !== socket.id && otherSocket.studentData?.id === studentId) {
            otherSocket.studentData = null;
            otherSocket.emit("kicked", { message: "You reconnected from another tab or device." });
            otherSocket.disconnect(true);
          }
        }
        socket.studentData = savedSd;
        if (activeSessions.has(studentId)) {
          const sess = activeSessions.get(studentId);
          sess.socketId = socket.id;
          sess.status   = "active";
        }
        console.log(`🔧 Re-attached session on submit: ${savedSd.name} (${studentId})`);
      }
    }

    if (!socket.studentData || socket.studentData.id !== studentId) {
      return socket.emit("submission-error", { message: "Session mismatch. Please log in again.", sessionLost: true });
    }

    if (socket.studentData.submitted) {
      return socket.emit("submission-error", { message: "You have already submitted." });
    }

    if (socket.studentData.paused) {
      return socket.emit("submission-error", { message: "Your quiz is currently paused by your teacher. Please wait." });
    }

    const elapsed = Date.now() - socket.studentData.startTime;
    const sessionDurationMs = socket.studentData.durationMs ?? getQuizDurationMs();

    if (elapsed > sessionDurationMs + GRACE_PERIOD_MS) {
      return socket.emit("submission-error", { message: "Time limit exceeded." });
    }

    if (
      typeof totalItems !== "number" ||
      totalItems !== socket.studentData.shuffledQuestions.length ||
      !Array.isArray(selectedAnswers) ||
      selectedAnswers.length !== totalItems
    ) {
      return socket.emit("submission-error", { message: "Invalid submission data." });
    }

    const choiceCount = 4;
    const sdForValidation = socket.studentData;
    for (let i = 0; i < selectedAnswers.length; i++) {
      const ans = selectedAnswers[i];
      const origQ = sdForValidation.shuffledQuestions[i];
      const itemType = normalizeItemType(origQ && origQ.type);
      if (itemType === "identification") {
        if (typeof ans !== "string") {
          return socket.emit("submission-error", { message: "Malformed answer data." });
        }
      } else if (itemType === "matching") {
        const pairCount = origQ && Array.isArray(origQ.pairs) ? origQ.pairs.length : 0;
        const valid = Array.isArray(ans) && ans.length === pairCount &&
          ans.every(v => typeof v === "number" && Number.isInteger(v) && (v === -1 || (v >= 0 && v < pairCount)));
        if (!valid) {
          return socket.emit("submission-error", { message: "Malformed answer data." });
        }
      } else {
        if (typeof ans !== "number" || (![-1].includes(ans) && (ans < 0 || ans >= choiceCount))) {
          return socket.emit("submission-error", { message: "Malformed answer data." });
        }
      }
    }

    // Close out any still-open item timer
    const sd = socket.studentData;
    const now = Date.now();
    for (let i = 0; i < sd.shuffledQuestions.length; i++) {
      if (sd.itemViewStart[i] !== null) {
        sd.itemTimeMs[i] += now - sd.itemViewStart[i];
        sd.itemViewStart[i] = null;
      }
    }

    let score = 0;
    const correctness = [];
    const maxScore = sd.maxScore || sd.shuffledQuestions.length;

    const questionMap = selectedAnswers.map((selectedAnswer, clientIndex) => {
      const origQ        = sd.shuffledQuestions[clientIndex];
      const itemType     = normalizeItemType(origQ.type);
      const points       = (sd.pointsSnapshot && sd.pointsSnapshot[origQ.num]) || 1;

      if (itemType === "identification") {
        const typedAnswer   = String(selectedAnswer || "");
        const correctAnswer = origQ.answer;
        const isCorrect     = typedAnswer.trim().length > 0 &&
          normalizeIdentificationAnswer(typedAnswer) === sd.correctAnswers[origQ.num];
        if (isCorrect) score += points;
        correctness.push(isCorrect);
        return {
          num:           origQ.num,
          type:          itemType,
          q:             origQ.q,
          passage:       origQ.passage || "",
          image:       origQ.image || "",
          typedAnswer,
          correctAnswer,
          isCorrect,
          points,
          pointsEarned:  isCorrect ? points : 0,
          timeMs:        sd.itemTimeMs[clientIndex],
          answerChanges: sd.answerChanges[clientIndex],
        };
      }

      if (itemType === "matching") {
        const options         = sd.questionDataForClient[clientIndex].options;
        const correctIndexes  = sd.correctAnswers[origQ.num] || [];
        const selected         = Array.isArray(selectedAnswer) ? selectedAnswer : [];
        const pairCount        = origQ.pairs.length;
        const perPairCorrect   = [];
        let correctPairs       = 0;
        for (let p = 0; p < pairCount; p++) {
          const sel = selected[p];
          const ok  = sel !== undefined && sel !== -1 && sel === correctIndexes[p];
          perPairCorrect.push(ok);
          if (ok) correctPairs++;
        }
        const isCorrect    = pairCount > 0 && correctPairs === pairCount;
        const pointsEarned = pairCount > 0 ? Math.round((points * correctPairs / pairCount) * 100) / 100 : 0;
        score += pointsEarned;
        correctness.push(isCorrect);
        return {
          num:            origQ.num,
          type:           itemType,
          q:              origQ.q,
          passage:        origQ.passage || "",
          image:        origQ.image || "",
          leftItems:      origQ.pairs.map(p => p.left),
          options,
          selected,
          correctIndexes,
          perPairCorrect,
          correctPairs,
          pairCount,
          isCorrect,
          points,
          pointsEarned,
          timeMs:         sd.itemTimeMs[clientIndex],
          answerChanges:  sd.answerChanges[clientIndex],
        };
      }

      const selectedIndex = selectedAnswer;
      const correctIndex  = sd.correctAnswers[origQ.num];
      const isCorrect     = selectedIndex !== -1 && selectedIndex === correctIndex;
      if (isCorrect) score += points;
      correctness.push(isCorrect);
      return {
        num:           origQ.num,
        type:          itemType,
        q:             origQ.q,
        passage:       origQ.passage || "",
        image:       origQ.image || "",
        choices:       sd.questionDataForClient[clientIndex].choices,
        selectedIndex,
        correctIndex,
        isCorrect,
        points,
        pointsEarned:  isCorrect ? points : 0,
        timeMs:        sd.itemTimeMs[clientIndex],
        answerChanges: sd.answerChanges[clientIndex],
      };
    });

    const percentage = Number(((score / maxScore) * 100).toFixed(1));

    const entry = {
      studentId,
      name,
      gradeSection,
      score,
      percentage,
      totalItems,
      maxScore,
      answers:       correctness,
      questionMap,
      tabSwitches:   sd.tabSwitches,
      pasteFlags:    sd.pasteFlags,
      autoSubmitted: sd.autoSubmitted,
      timestamp:     new Date().toISOString(),
      durationMs:    elapsed,
      itemTimeMs:    sd.itemTimeMs,
      answerChanges: sd.answerChanges,
    };

    submissions.push(entry);
    socket.studentData.submitted = true;
    studentSessions.delete(studentId);
    saveInProgressSessions();

    if (activeSessions.has(studentId)) {
      const sess = activeSessions.get(studentId);
      sess.status     = "submitted";
      sess.score      = score;
      sess.maxScore   = maxScore;
      sess.percentage = percentage;
      broadcastActiveSessions();
    }

    saveData();
    io.emit("quiz-update", getCurrentState());

    // Instant submission notification to dashboard
    io.emit("student-submitted", {
      studentId,
      name,
      section:       gradeSection,
      score,
      maxScore,
      percentage,
      totalItems,
      tabSwitches:   sd.tabSwitches,
      pasteFlags:    sd.pasteFlags,
      autoSubmitted: sd.autoSubmitted,
      timestamp:     entry.timestamp,
    });

    // Build a client-safe review payload (right/wrong + correct answer per item)
    const review = questionMap.map(item => item.type === "identification" ? ({
      num:           item.num,
      type:          item.type,
      q:             item.q,
      passage:       item.passage || "",
      image:       item.image || "",
      typedAnswer:   item.typedAnswer,
      correctAnswer: item.correctAnswer,
      isCorrect:     item.isCorrect,
      points:        item.points,
      pointsEarned:  item.pointsEarned,
    }) : item.type === "matching" ? ({
      num:            item.num,
      type:           item.type,
      q:              item.q,
      passage:        item.passage || "",
      image:        item.image || "",
      leftItems:      item.leftItems,
      options:        item.options,
      selected:       item.selected,
      correctIndexes: item.correctIndexes,
      perPairCorrect: item.perPairCorrect,
      correctPairs:   item.correctPairs,
      pairCount:      item.pairCount,
      isCorrect:      item.isCorrect,
      points:         item.points,
      pointsEarned:   item.pointsEarned,
    }) : ({
      num:           item.num,
      type:          item.type,
      q:             item.q,
      passage:       item.passage || "",
      image:       item.image || "",
      choices:       item.choices,
      selectedIndex: item.selectedIndex,
      correctIndex:  item.correctIndex,
      isCorrect:     item.isCorrect,
      points:        item.points,
      pointsEarned:  item.pointsEarned,
    }));

    // Stash the full review so it can be pushed later if the teacher turns results ON
    socket.studentData.pendingReview = { score, percentage, totalItems, maxScore, review };
    socket.studentData.resultsSent   = resultsVisible;

    if (resultsVisible) {
      socket.emit("submission-received", { score, percentage, totalItems, maxScore, review, resultsVisible: true });
    } else {
      // Score is recorded server-side, but withheld from the student until the teacher releases it
      socket.emit("submission-received", { score: null, percentage: null, totalItems, maxScore, review: [], resultsVisible: false });
    }
    console.log(`📝 Submitted: ${name} (${studentId}) | Score: ${score}/${maxScore} (${percentage}%)${resultsVisible ? "" : " | Results withheld"}`);
  });

  // ── Tab-switch / focus-loss tracking ─────────────────────────────────────
  socket.on("tab-switch", ({ count } = {}) => {
    if (!socket.studentData || socket.studentData.submitted) return;

    socket.studentData.tabSwitches = typeof count === "number" ? count : socket.studentData.tabSwitches + 1;

    if (activeSessions.has(socket.studentData.id)) {
      activeSessions.get(socket.studentData.id).tabSwitches = socket.studentData.tabSwitches;
      broadcastActiveSessions();
    }

    console.log(`⚠  Tab switch | ${socket.studentData.name} (${socket.studentData.id}) | Count: ${socket.studentData.tabSwitches}`);

    io.emit("integrity-event", {
      type:      "tab-switch",
      studentId: socket.studentData.id,
      name:      socket.studentData.name,
      section:   socket.studentData.section,
      count:     socket.studentData.tabSwitches,
      timestamp: new Date().toISOString(),
    });

    socket.emit("tab-switch-warning", {
      count:      socket.studentData.tabSwitches,
      maxAllowed: MAX_TAB_SWITCHES,
    });

    if (socket.studentData.tabSwitches >= MAX_TAB_SWITCHES) {
      console.log(`🚨 Auto-submitting ${socket.studentData.name} – too many tab switches`);
      socket.studentData.autoSubmitted = true;

      io.emit("integrity-event", {
        type:      "auto-submit",
        studentId: socket.studentData.id,
        name:      socket.studentData.name,
        section:   socket.studentData.section,
        count:     socket.studentData.tabSwitches,
        timestamp: new Date().toISOString(),
      });

      socket.emit("force-submit", { reason: "Too many tab switches detected." });
    }
  });

  // ── Admin: reset data ────────────────────────────────────────────────────
  // Shared by the plain "Reset" action and "Archive & Reset". Does NOT touch
  // quizArchive — archiving (if any) must happen by the caller before this runs.
  function performReset(section) {
    if (section) {
      // Per-section reset: remove only submissions and active sessions for that section
      submissions = submissions.filter(s => s.gradeSection !== section);
      for (const [id, sess] of activeSessions.entries()) {
        if (sess.section === section) activeSessions.delete(id);
      }
      for (const [id, sd] of studentSessions.entries()) {
        if (sd.section === section) studentSessions.delete(id);
      }
      console.log(`🗑  Quiz data reset for section: ${section}`);
    } else {
      // Full reset: clear everything
      submissions = [];
      itemCount   = 0;
      activeSessions.clear();
      studentSessions.clear();
      try {
        if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
      } catch (err) {
        console.error("❌ Could not delete data file:", err.message);
      }
      console.log("🗑  Quiz data reset by admin (all sections).");
    }

    saveInProgressSessions();
    saveData();
    io.emit("quiz-update", getCurrentState());
    io.emit("active-sessions-update", Array.from(activeSessions.values()));
    broadcastRoster();
  }

  socket.on("reset-quiz-data", ({ password, section } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("reset-failed", { message: "Incorrect password." });
    }
    performReset(section);
    socket.emit("reset-success", { section });
  });

  // ── Admin: lightweight password check ────────────────────────────────────
  // Read-only verification, used by UI affordances that just need to gate
  // something client-side (e.g. revealing disabled subjects in the Sections
  // panel) without performing any admin action or mutating any data.
  socket.on("admin-verify-password", ({ password, context } = {}) => {
    socket.emit("verify-password-result", { ok: password === RESET_PASSWORD, context: context || null });
  });

  // ── Admin: archive the current exam, then reset ─────────────────────────
  // Snapshots the current submissions (filtered to the chosen section, or all
  // of them for a full reset) into the permanent quiz-archive.json record,
  // then performs the same reset as above. Archived entries are never removed
  // by a reset, so every past exam stays retrievable.
  socket.on("admin-archive-and-reset", ({ password, name, section, examType, mergeIntoId } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("archive-failed", { message: "Incorrect password." });
    }

    const scopedSubmissions = section
      ? submissions.filter(s => s.gradeSection === section)
      : submissions.slice();

    if (scopedSubmissions.length === 0) {
      return socket.emit("archive-failed", { message: "No submissions to archive for this scope." });
    }

    // ── MAKE-UP MERGE ────────────────────────────────────────────────────────
    // If the teacher picked an existing archive, add these (late/absent)
    // students' scores INTO that archived exam instead of creating a new one.
    // Nobody already in the archive is overwritten or duplicated.
    if (mergeIntoId) {
      const target = quizArchive.find(a => a.id === mergeIntoId);
      if (!target) {
        return socket.emit("archive-failed", { message: "The archived exam you picked was not found." });
      }
      if (!section) {
        return socket.emit("archive-failed", { message: "To add to an existing archive, pick ONE section–subject (not All Sections)." });
      }
      if (target.section !== section) {
        return socket.emit("archive-failed", { message: `That archive belongs to ${target.section || "another section"}, not ${section}.` });
      }
      if (scopedSubmissions.some(s => (s.maxScore ?? s.totalItems) !== target.maxScore)) {
        return socket.emit("archive-failed", { message: `Total points don't match the archived exam (${target.maxScore}). Use "Load Archived Exam" so the make-up uses the same questions and points.` });
      }
      const alreadyIn = new Set((target.submissions || []).map(s => s.studentId));
      const fresh = scopedSubmissions.filter(s => !alreadyIn.has(s.studentId));
      const skipped = scopedSubmissions.length - fresh.length;
      if (fresh.length === 0) {
        return socket.emit("archive-failed", { message: "Everyone in the live data is already in that archive — nothing to add." });
      }

      const prevSubs = target.submissions || [];
      const prev = { submissionCount: target.submissionCount, avgPercentage: target.avgPercentage };
      target.submissions = [...prevSubs, ...fresh];
      target.submissionCount = target.submissions.length;
      target.avgPercentage = Math.round((target.submissions.reduce((sum, s) => sum + (s.percentage || 0), 0) / target.submissions.length) * 10) / 10;
      target.lastMergedAt = new Date().toISOString();

      if (!saveArchive()) {
        target.submissions = prevSubs;
        target.submissionCount = prev.submissionCount;
        target.avgPercentage = prev.avgPercentage;
        delete target.lastMergedAt;
        return socket.emit("archive-failed", { message: "Could not save the archive to disk, so nothing was changed. Your live scores are still safe." });
      }
      console.log(`🧩 Merged ${fresh.length} make-up submission(s) into archive "${target.name}" (${skipped} duplicate(s) skipped)`);
      performReset(section);
      return socket.emit("archive-success", { id: target.id, name: target.name, section, examType: target.examType, submissionCount: fresh.length, entries: 1, merged: true, skipped, total: target.submissionCount });
    }

    // Each section-subject has its own exam, so every key gets its own archive
    // entry (its own questions/points/type). A single-key archive makes one
    // entry; "All sections" makes one per key that has submissions.
    const groups = new Map();
    for (const sub of scopedSubmissions) {
      if (!groups.has(sub.gradeSection)) groups.set(sub.gradeSection, []);
      groups.get(sub.gradeSection).push(sub);
    }
    const baseName = (name && String(name).trim()) || `Untitled Exam — ${new Date().toLocaleDateString()}`;
    const multi = groups.size > 1;

    const newEntries = [];
    for (const [key, subs] of groups) {
      const exam = examsByKey.get(key) || getExam(key);
      const normalizedType = examType && !multi ? normalizeExamType(examType) : exam.examType;
      const avgPercentage = subs.reduce((sum, s) => sum + (s.percentage || 0), 0) / subs.length;
      newEntries.push({
        id: `arc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
        name: multi ? `${baseName} — ${key}` : baseName,
        section: key,
        examType: normalizedType,
        archivedAt: new Date().toISOString(),
        itemCount: exam.questions.length,
        maxScore: getMaxScore(exam),
        questions: exam.questions.map(q => ({ num: q.num, type: normalizeItemType(q.type), q: q.q, passage: q.passage || "", choices: q.choices, correct: q.correct, answer: q.answer, pairs: q.pairs, points: getPoints(q.num, exam) })),
        submissionCount: subs.length,
        avgPercentage: Math.round(avgPercentage * 10) / 10,
        submissions: subs,
      });
    }

    quizArchive.push(...newEntries);
    if (!saveArchive()) {
      // Not saved to disk — undo the in-memory add and DO NOT reset, so the
      // live scores are still there and nothing is lost.
      quizArchive.splice(quizArchive.length - newEntries.length, newEntries.length);
      return socket.emit("archive-failed", { message: "Could not save the archive to disk, so nothing was reset and the scores are still safe in the live data. Check that the SERVER folder is writable and the disk isn't full, then try again." });
    }
    for (const entry of newEntries) {
      console.log(`🗄  Archived ${entry.examType} "${entry.name}" (${entry.submissionCount} submissions, section: ${entry.section})`);
    }

    performReset(section);
    const first = newEntries[0];
    socket.emit("archive-success", { id: first.id, name: first.name, section: section || null, examType: first.examType, submissionCount: scopedSubmissions.length, entries: newEntries.length });
  });

  // ── Admin: list archived exams (summaries only — no full submission payload) ─
  socket.on("get-quiz-archives", ({ password } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("archives-failed", { message: "Incorrect password." });
    }
    const summaries = quizArchive
      .map(a => ({
        id: a.id,
        name: a.name,
        section: a.section,
        examType: a.examType || "Quiz",
        archivedAt: a.archivedAt,
        submissionCount: a.submissionCount,
        avgPercentage: a.avgPercentage,
        maxScore: a.maxScore,
      }))
      .sort((a, b) => {
        const secA = a.section || "All Sections";
        const secB = b.section || "All Sections";
        const secCmp = secA.localeCompare(secB);
        if (secCmp !== 0) return secCmp;
        return new Date(b.archivedAt) - new Date(a.archivedAt);
      });
    socket.emit("quiz-archives-list", summaries);
  });

  // ── Admin: fetch full detail (submissions) for one archived exam ────────────
  socket.on("get-quiz-archive-detail", ({ password, id } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("archives-failed", { message: "Incorrect password." });
    }
    const entry = quizArchive.find(a => a.id === id);
    if (!entry) return socket.emit("archives-failed", { message: "Archive not found." });
    socket.emit("quiz-archive-detail", entry);
  });

  // ── Admin: delete a mistaken/unwanted archive entry ──────────────────────────
  socket.on("delete-quiz-archive", ({ password, id } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("archives-failed", { message: "Incorrect password." });
    }
    const before = quizArchive.length;
    quizArchive = quizArchive.filter(a => a.id !== id);
    if (quizArchive.length === before) {
      return socket.emit("archives-failed", { message: "Archive not found." });
    }
    saveArchive();
    socket.emit("archive-deleted", { id });
  });

  // ── Admin: student scores report (Quiz / Summative / Term Exam, per student) ─
  socket.on("get-student-scores", ({ password } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("student-scores-failed", { message: "Incorrect password." });
    }
    const { exams, students } = buildStudentScoresReport();
    socket.emit("student-scores-data", { exams, students });
  });

  // ── Admin: snapshot whatever question set is currently loaded ───────────────
  // Triggered by the "Snapshot Questions" toolbar button. Independent of
  // submissions/resets — just records the realQuestions array (as it exists
  // in server.js right now) into question-history.json, so every version of
  // the quiz you've ever run stays browsable, even after you overwrite
  // realQuestions with a new set and restart the server.
  socket.on("admin-save-question-snapshot", ({ password, name, sectionKey: rawKey } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("question-snapshot-failed", { message: "Incorrect password." });
    }
    const key = resolveAdminKey(rawKey);
    if (!key) return socket.emit("question-snapshot-failed", { message: "Pick a section–subject first." });
    const exam = getExam(key);

    const entry = {
      id: `qh_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      name: (name && String(name).trim()) || `Untitled — ${new Date().toLocaleDateString()}`,
      savedAt: new Date().toISOString(),
      itemCount: exam.questions.length,
      maxScore: getMaxScore(exam),
      questions: exam.questions.map(q => ({ num: q.num, type: normalizeItemType(q.type), q: q.q, passage: q.passage || "", choices: q.choices, correct: q.correct, answer: q.answer, pairs: q.pairs, points: getPoints(q.num, exam) })),
    };

    questionHistory.push(entry);
    saveQuestionHistory();
    console.log(`📸 Saved question snapshot "${entry.name}" (${entry.itemCount} items)`);

    socket.emit("question-snapshot-saved", { id: entry.id, name: entry.name, itemCount: entry.itemCount });
  });

  // ── Admin: list saved question snapshots (summaries only) ───────────────────
  socket.on("get-question-history", ({ password } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("question-history-failed", { message: "Incorrect password." });
    }
    const summaries = questionHistory
      .map(h => ({ id: h.id, name: h.name, savedAt: h.savedAt, itemCount: h.itemCount, maxScore: h.maxScore }))
      .sort((a, b) => new Date(b.savedAt) - new Date(a.savedAt));
    socket.emit("question-history-list", summaries);
  });

  // ── Admin: fetch the full question text/choices for one snapshot ────────────
  socket.on("get-question-history-detail", ({ password, id } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("question-history-failed", { message: "Incorrect password." });
    }
    const entry = questionHistory.find(h => h.id === id);
    if (!entry) return socket.emit("question-history-failed", { message: "Snapshot not found." });
    socket.emit("question-history-detail", entry);
  });

  // ── Admin: delete a mistaken/unwanted question snapshot ─────────────────────
  socket.on("delete-question-history", ({ password, id } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("question-history-failed", { message: "Incorrect password." });
    }
    const before = questionHistory.length;
    questionHistory = questionHistory.filter(h => h.id !== id);
    if (questionHistory.length === before) {
      return socket.emit("question-history-failed", { message: "Snapshot not found." });
    }
    saveQuestionHistory();
    socket.emit("question-history-item-deleted", { id });
  });

  // ── Admin: Item Bank — list every item in the pool ───────────────────────────
  socket.on("admin-get-item-bank", ({ password } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("item-bank-error", { message: "Incorrect password." });
    }
    // Newest first: the most recently added/uploaded items are listed at the top.
    // Items from the same Word import share one timestamp, so ties keep their
    // original order (question 1, 2, 3...) within that upload.
    const stamp = it => { const t = new Date(it.createdAt).getTime(); return Number.isFinite(t) ? t : 0; };
    const sorted = itemBank
      .map((it, idx) => ({ it, idx }))
      .sort((a, b) => (stamp(b.it) - stamp(a.it)) || (a.idx - b.idx))
      .map(x => x.it);
    socket.emit("item-bank-list", sorted);
  });

  // Validates the type-specific fields for an item bank item. Returns either
  // { ok: true, fields } (fields to merge onto the item) or { ok: false, message }.
  function validateItemBankFields({ type, q, choices, correct, answer, pairs }) {
    const itemType = normalizeItemType(type);
    const text = typeof q === "string" ? q.trim() : "";
    if (!text) {
      return { ok: false, message: "Question text is required." };
    }

    if (itemType === "identification") {
      const answerText = typeof answer === "string" ? answer.trim() : "";
      if (!answerText) {
        return { ok: false, message: "Provide the correct answer." };
      }
      return { ok: true, fields: { type: itemType, q: text, answer: answerText, choices: undefined, correct: undefined, pairs: undefined } };
    }

    if (itemType === "matching") {
      const cleanPairs = Array.isArray(pairs)
        ? pairs
            .map(p => ({
              left:  typeof p?.left === "string" ? p.left.trim() : "",
              right: typeof p?.right === "string" ? p.right.trim() : "",
            }))
            .filter(p => p.left.length > 0 && p.right.length > 0)
        : [];
      if (cleanPairs.length < 3 || cleanPairs.length > 8) {
        return { ok: false, message: "Provide between 3 and 8 matching pairs (each with both sides filled in)." };
      }
      const rightKey = cleanPairs.map(p => p.right.toLowerCase());
      if (new Set(rightKey).size !== rightKey.length) {
        return { ok: false, message: "Right-side matches must be unique so grading is unambiguous." };
      }
      return { ok: true, fields: { type: itemType, q: text, pairs: cleanPairs, choices: undefined, correct: undefined, answer: undefined } };
    }

    const cleanChoices = Array.isArray(choices)
      ? choices.map(c => (typeof c === "string" ? c.trim() : "")).filter(c => c.length > 0)
      : [];
    if (cleanChoices.length < 2 || cleanChoices.length > 6) {
      return { ok: false, message: "Provide between 2 and 6 non-empty choices." };
    }
    const correctIdx = Number(correct);
    if (!Number.isInteger(correctIdx) || correctIdx < 0 || correctIdx >= cleanChoices.length) {
      return { ok: false, message: "Select which choice is correct." };
    }
    return { ok: true, fields: { type: itemType, q: text, choices: cleanChoices, correct: correctIdx, answer: undefined, pairs: undefined } };
  }

  // ── Admin: Item Bank — add one item (MC, identification, or matching) ────────
  socket.on("admin-add-item-bank-item", ({ password, topic, competency, passage, image, type, q, choices, correct, answer, pairs } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("item-bank-error", { message: "Incorrect password." });
    }
    const validated = validateItemBankFields({ type, q, choices, correct, answer, pairs });
    if (!validated.ok) {
      return socket.emit("item-bank-error", { message: validated.message });
    }
    const topicText = (typeof topic === "string" ? topic.trim() : "") || "General";
    const competencyText = typeof competency === "string" ? competency.trim() : "";

    const item = {
      id: `ib_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      topic: topicText,
      competency: competencyText,
      passage: cleanPassage(passage),
      image: cleanImage(image),
      createdAt: new Date().toISOString(),
      ...validated.fields,
    };
    itemBank.push(item);
    saveItemBank();
    console.log(`🗃  Item bank: added ${item.type} item under topic "${topicText}" (${itemBank.length} total)`);
    socket.emit("item-bank-item-added", { item, total: itemBank.length });
  });

  // ── Admin: Item Bank — edit an existing item in the pool ─────────────────────
  socket.on("admin-update-item-bank-item", ({ password, id, topic, competency, passage, image, type, q, choices, correct, answer, pairs } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("item-bank-error", { message: "Incorrect password." });
    }
    const item = itemBank.find(it => it.id === id);
    if (!item) {
      return socket.emit("item-bank-error", { message: "Item not found." });
    }
    const validated = validateItemBankFields({ type: type !== undefined ? type : item.type, q, choices, correct, answer, pairs });
    if (!validated.ok) {
      return socket.emit("item-bank-error", { message: validated.message });
    }
    const topicText = (typeof topic === "string" ? topic.trim() : "") || "General";
    const competencyText = typeof competency === "string" ? competency.trim() : "";

    item.topic = topicText;
    item.competency = competencyText;
    item.passage = cleanPassage(passage);
    if (image !== undefined) item.image = cleanImage(image);
    item.type = validated.fields.type;
    item.q = validated.fields.q;
    item.choices = validated.fields.choices;
    item.correct = validated.fields.correct;
    item.answer = validated.fields.answer;
    item.pairs = validated.fields.pairs;
    item.updatedAt = new Date().toISOString();

    saveItemBank();
    console.log(`🗃  Item bank: updated ${item.type} item ${id} under topic "${topicText}"`);
    socket.emit("item-bank-item-updated", { item, total: itemBank.length });
  });

  // ── Admin: Item Bank — delete an item from the pool ───────────────────────────
  socket.on("admin-delete-item-bank-item", ({ password, id } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("item-bank-error", { message: "Incorrect password." });
    }
    const before = itemBank.length;
    itemBank = itemBank.filter(it => it.id !== id);
    if (itemBank.length === before) {
      return socket.emit("item-bank-error", { message: "Item not found." });
    }
    saveItemBank();
    socket.emit("item-bank-item-deleted", { id, total: itemBank.length });
  });

  // ── Admin: Item Bank — delete every item under a given topic ──────────────────
  socket.on("admin-delete-item-bank-topic", ({ password, topic } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("item-bank-error", { message: "Incorrect password." });
    }
    const topicText = typeof topic === "string" ? topic.trim() : "";
    if (!topicText) {
      return socket.emit("item-bank-error", { message: "No topic specified." });
    }
    const before = itemBank.length;
    itemBank = itemBank.filter(it => (it.topic || "General") !== topicText);
    const removed = before - itemBank.length;
    if (removed === 0) {
      return socket.emit("item-bank-error", { message: `No items found under "${topicText}".` });
    }
    saveItemBank();
    console.log(`🗃  Item bank: deleted topic "${topicText}" (${removed} item(s) removed, ${itemBank.length} remain)`);
    socket.emit("item-bank-topic-deleted", { topic: topicText, count: removed, total: itemBank.length });
  });

  // ── Admin: Generate a quiz — random draw of N items from the bank ────────────
  // Replaces the live realQuestions set immediately (no restart needed) and
  // persists it to active-quiz.json so it survives a server restart too.
  // `topics` supports per-topic draw counts: [{ topic, count }, ...] — e.g. draw
  // 10 items from "Natural Selection" and 5 from "Livestock Breed" in one go.
  // For backward compatibility it also accepts a flat string array (uses `count`
  // as the total drawn across those topics combined) or a single `topic` string.
  socket.on("admin-generate-quiz-from-bank", ({ password, count, topic, topics, sectionKey: rawKey } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("quiz-generate-error", { message: "Incorrect password." });
    }
    const key = resolveAdminKey(rawKey);
    if (!key) return socket.emit("quiz-generate-error", { message: "Pick a section–subject first." });
    const exam = getExam(key);

    const byTopic = Array.isArray(topics) && topics.length && typeof topics[0] === "object" && topics[0] !== null;

    if (byTopic) {
      // ── Per-topic draw: pull an independent random sample from each topic ──
      const entries = topics
        .map(t => ({ topic: typeof t.topic === "string" ? t.topic.trim() : "", count: Number(t.count) }))
        .filter(t => t.topic);

      if (!entries.length) {
        return socket.emit("quiz-generate-error", { message: "Pick at least one topic." });
      }
      for (const e of entries) {
        if (!Number.isInteger(e.count) || e.count < 1) {
          return socket.emit("quiz-generate-error", { message: `Enter a valid item count for "${e.topic}".` });
        }
      }

      const drawnItems = [];
      for (const e of entries) {
        const pool = itemBank.filter(it => (it.topic || "General") === e.topic);
        if (e.count > pool.length) {
          return socket.emit("quiz-generate-error", {
            message: `"${e.topic}" only has ${pool.length} item${pool.length === 1 ? "" : "s"} — can't draw ${e.count}.`,
          });
        }
        drawnItems.push(...shuffle(pool).slice(0, e.count));
      }

      // Group into fixed type blocks (MC, then Identification, then Matching);
      // shuffling happens only within each block, never across types.
      const drawn = groupByTypeThenShuffle(drawnItems);
      exam.questions = drawn.map((it, i) => ({
        num: i + 1,
        type: normalizeItemType(it.type),
        q: it.q,
        choices: it.choices,
        correct: it.correct,
        answer: it.answer,
        pairs: it.pairs,
        topic: it.topic || "General",
        competency: it.competency || "",
        passage: it.passage || "",
        image: it.image || "",
      }));
      exam.points = {};
      saveExams();
      console.log(`🎲 Generated quiz for ${key}: ${exam.questions.length} item(s) drawn per-topic (${entries.map(e => `${e.topic}: ${e.count}`).join(", ")})`);
      broadcastExamStatus();
      io.emit("quiz-update", getCurrentState());
      return io.emit("quiz-generated", { sectionKey: key, itemCount: exam.questions.length, source: "bank", topics: entries });
    }

    // ── Legacy path: single combined pool, total count ──────────────────────
    const n = Number(count);
    if (!Number.isInteger(n) || n < 1) {
      return socket.emit("quiz-generate-error", { message: "Enter a valid number of items to draw." });
    }
    let topicFilters = Array.isArray(topics)
      ? topics.map(t => (typeof t === "string" ? t.trim() : "")).filter(Boolean)
      : [];
    if (!topicFilters.length && typeof topic === "string" && topic.trim()) {
      topicFilters = [topic.trim()];
    }
    const topicSet = new Set(topicFilters);
    const pool = topicSet.size ? itemBank.filter(it => topicSet.has(it.topic || "General")) : itemBank;
    const topicLabel = topicFilters.length === 1
      ? `"${topicFilters[0]}"`
      : topicFilters.length > 1
        ? `${topicFilters.length} selected topics`
        : "";
    if (n > pool.length) {
      return socket.emit("quiz-generate-error", {
        message: topicLabel
          ? `${topicLabel} only ${pool.length === 1 ? "has" : "have"} ${pool.length} item${pool.length === 1 ? "" : "s"} — can't draw ${n}.`
          : `The bank only has ${pool.length} item${pool.length === 1 ? "" : "s"} — can't draw ${n}.`,
      });
    }

    // Randomly pick n items from the pool, then reorder into fixed type
    // blocks (MC, then Identification, then Matching) — shuffled only
    // within each block, never mixed across types.
    const drawn = groupByTypeThenShuffle(shuffle(pool).slice(0, n));
    exam.questions = drawn.map((it, i) => ({
      num: i + 1,
      type: normalizeItemType(it.type),
      q: it.q,
      choices: it.choices,
      correct: it.correct,
      answer: it.answer,
      pairs: it.pairs,
      topic: it.topic || "General",
      competency: it.competency || "",
      passage: it.passage || "",
      image: it.image || "",
    }));
    exam.points = {};
    saveExams();
    console.log(`🎲 Generated quiz for ${key}: ${exam.questions.length} item(s) drawn from item bank${topicLabel ? ` (topics: ${topicFilters.join(", ")})` : ""}`);
    broadcastExamStatus();
    io.emit("quiz-update", getCurrentState());
    io.emit("quiz-generated", { sectionKey: key, itemCount: exam.questions.length, source: "bank", topics: topicFilters });
  });

  // ── Admin: Restore the original default question set ─────────────────────────
  socket.on("admin-restore-default-questions", ({ password, sectionKey: rawKey } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("quiz-generate-error", { message: "Incorrect password." });
    }
    const key = resolveAdminKey(rawKey);
    if (!key) return socket.emit("quiz-generate-error", { message: "Pick a section–subject first." });
    const exam = getExam(key);
    exam.questions = DEFAULT_QUESTIONS.map(q => ({ ...q }));
    exam.points = {};
    saveExams();
    console.log(`↩️  Restored default question set for ${key} (${exam.questions.length} item(s))`);
    broadcastExamStatus();
    io.emit("quiz-update", getCurrentState());
    io.emit("quiz-generated", { sectionKey: key, itemCount: exam.questions.length, source: "default" });
  });

  // ── Admin: load an archived exam's questions + points into one key ─────────
  // Used for make-up exams: copies entry.questions and their points into that
  // key's exam. Submissions are NOT touched. Refused while students are mid-exam
  // on that key, since it would change their question count.
  socket.on("admin-load-exam-from-archive", ({ password, sectionKey: rawKey, archiveId } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("quiz-generate-error", { message: "Incorrect password." });
    }
    const key = resolveAdminKey(rawKey);
    if (!key) return socket.emit("quiz-generate-error", { message: "Pick a section–subject first." });
    const entry = quizArchive.find(a => a.id === archiveId);
    if (!entry || !Array.isArray(entry.questions) || !entry.questions.length) {
      return socket.emit("quiz-generate-error", { message: "That archived exam has no saved questions to load." });
    }
    for (const sess of activeSessions.values()) {
      if (sess.section === key && sess.status !== "submitted") {
        return socket.emit("quiz-generate-error", { message: "Students are still taking this exam. Wait until they finish before loading another one." });
      }
    }
    const exam = getExam(key);
    exam.questions = entry.questions.map((q, i) => {
      const { points, ...rest } = q;
      return { ...rest, num: q.num ?? i + 1 };
    });
    exam.points = {};
    entry.questions.forEach((q, i) => { exam.points[q.num ?? i + 1] = (typeof q.points === "number" && q.points > 0) ? q.points : 1; });
    if (entry.examType) exam.examType = normalizeExamType(entry.examType);
    saveExams();
    console.log(`📂 Loaded archived exam "${entry.name}" into ${key} (${exam.questions.length} item(s))`);
    broadcastExamStatus();
    io.emit("quiz-update", getCurrentState());
    io.emit("quiz-generated", { sectionKey: key, itemCount: exam.questions.length, source: "archive", archiveName: entry.name });
  });

  // ── Admin: kick/remove a live student ─────────────────────────────────────
  socket.on("admin-kick-student", ({ password, studentId } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("kick-failed", { message: "Incorrect password." });
    }

    if (!studentId || !activeSessions.has(studentId)) {
      return socket.emit("kick-failed", { message: "Student not found or already disconnected." });
    }

    const session = activeSessions.get(studentId);
    const name = session.name;
    const wasSubmitted = session.status === "submitted";

    const targetSocket = io.sockets.sockets.get(session.socketId);
    if (targetSocket) {
      targetSocket.emit("kicked", { message: "You have been removed from the quiz by your teacher." });
      targetSocket.disconnect(true);
    }

    activeSessions.delete(studentId);
    studentSessions.delete(studentId);

    // Kicking a student who already submitted is treated as undoing an
    // accidental submission: clear their graded entry too, so their name
    // frees up on the roster and they can log back in and retake it.
    if (wasSubmitted) {
      submissions = submissions.filter(s => s.studentId !== studentId);
      saveData();
      io.emit("quiz-update", getCurrentState());
    }

    saveInProgressSessions();
    broadcastActiveSessions();
    broadcastRoster();

    console.log(`👢 Student kicked by admin: ${name} (${studentId})${wasSubmitted ? " — submission cleared" : ""}`);
    socket.emit("kick-success", { studentId, name, wasSubmitted });
  });

  // ── Admin: release a DISCONNECTED student so they can continue on another
  // laptop. Unlike kick, this keeps the saved session (shuffled questions,
  // answers, flags, start time), so the student logs in anywhere and resumes.
  socket.on("admin-release-student", ({ studentId } = {}) => {
    const session = studentId ? activeSessions.get(studentId) : null;
    if (!session || session.status !== "disconnected") {
      return socket.emit("release-failed", { message: "Release is only available for students who are currently disconnected." });
    }

    const sd = studentSessions.get(studentId);
    if (!sd || sd.submitted) {
      return socket.emit("release-failed", { message: "No saved progress to resume for this student." });
    }

    const sdDurationMs = sd.durationMs ?? getQuizDurationMs();
    if (Date.now() - sd.startTime > sdDurationMs + GRACE_PERIOD_MS) {
      return socket.emit("release-failed", { message: "This student's time has already run out." });
    }

    // Defensive: drop any lingering socket still bound to this student so
    // the "another session is already active" login check can't block them.
    for (const [, other] of io.sockets.sockets) {
      if (other.id !== socket.id && other.studentData?.id === studentId) {
        other.emit("kicked", { message: "Your session was released by your teacher." });
        other.disconnect(true);
      }
    }

    session.status = "disconnected";
    saveInProgressSessions();
    broadcastActiveSessions();
    broadcastRoster();

    console.log(`🔓 Session released by admin: ${session.name} (${studentId}) — can resume on another device`);
    socket.emit("release-success", { studentId, name: session.name });
  });

  // ── Admin: pause/resume a live student (locks them out of answering
  // without disconnecting them — handy for noisy/disruptive students) ───────
  socket.on("admin-toggle-pause-student", ({ studentId, paused } = {}) => {
    if (!studentId || !activeSessions.has(studentId)) {
      return socket.emit("pause-failed", { message: "Student not found or already disconnected." });
    }

    const session   = activeSessions.get(studentId);
    const isPaused  = Boolean(paused);
    session.paused  = isPaused;

    const targetSocket = io.sockets.sockets.get(session.socketId);
    if (targetSocket && targetSocket.studentData) {
      targetSocket.studentData.paused = isPaused;
      targetSocket.emit("paused-state", {
        paused:  isPaused,
        message: isPaused
          ? "Di magpalabi banha. 1 Minute di pa ka ka.pindot."
          : "You may continue answering.",
      });
    }

    // Also keep the persisted in-progress session in sync, so the pause
    // survives a page reload/reconnect.
    if (studentSessions.has(studentId)) {
      studentSessions.get(studentId).paused = isPaused;
      saveInProgressSessions();
    }

    broadcastActiveSessions();

    console.log(`${isPaused ? "⏸ " : "▶️ "}Student ${isPaused ? "paused" : "resumed"} by admin: ${session.name} (${studentId})`);
    socket.emit("pause-success", { studentId, name: session.name, paused: isPaused });
  });

  // ── Admin: send a private message to one live student (e.g. a quiet
  // heads-up to stop talking/looking around, without pausing or kicking
  // them, or embarrassing them in front of the class) ────────────────────
  const MAX_STUDENT_MESSAGE_LENGTH = 300;
  socket.on("admin-send-student-message", ({ studentId, message } = {}) => {
    if (!studentId || !activeSessions.has(studentId)) {
      return socket.emit("message-failed", { message: "Student not found or already disconnected." });
    }

    const cleanMessage = String(message ?? "").trim().slice(0, MAX_STUDENT_MESSAGE_LENGTH);
    if (!cleanMessage) {
      return socket.emit("message-failed", { message: "Message cannot be empty." });
    }

    const session = activeSessions.get(studentId);
    const targetSocket = io.sockets.sockets.get(session.socketId);
    if (!targetSocket) {
      return socket.emit("message-failed", { message: `${session.name} is not currently connected.` });
    }

    targetSocket.emit("teacher-message", { message: cleanMessage, sentAt: Date.now() });

    console.log(`✉️  Private message sent by admin to ${session.name} (${studentId}): "${cleanMessage}"`);
    socket.emit("message-sent", { studentId, name: session.name });
  });

  // ── Student: ask the teacher a private question about the quiz. This is a
  // ONE-WAY channel in the other direction from admin-send-student-message
  // above — students can raise a question here, but there is no way for a
  // student to reply to a teacher's message (that overlay is "OK" only), so
  // this never turns into a back-and-forth chat that could disrupt the exam.
  // If the teacher wants to respond, they do so the normal way: a private
  // message back to that student. ─────────────────────────────────────────
  socket.on("student-send-admin-message", ({ message } = {}) => {
    const sd = socket.studentData;
    if (!sd || !activeSessions.has(sd.id)) {
      return socket.emit("student-message-failed", { message: "You must be logged in to send a question." });
    }

    const now = Date.now();
    const lastSent = studentQuestionCooldown.get(sd.id) || 0;
    if (now - lastSent < STUDENT_QUESTION_COOLDOWN_MS) {
      const waitSec = Math.ceil((STUDENT_QUESTION_COOLDOWN_MS - (now - lastSent)) / 1000);
      return socket.emit("student-message-failed", { message: `Please wait ${waitSec}s before sending another question.` });
    }

    const cleanMessage = String(message ?? "").trim().slice(0, MAX_STUDENT_QUESTION_LENGTH);
    if (!cleanMessage) {
      return socket.emit("student-message-failed", { message: "Question cannot be empty." });
    }

    const session = activeSessions.get(sd.id);
    const entry = {
      id: `sq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`,
      studentId: sd.id,
      name: session.name,
      section: session.section,
      message: cleanMessage,
      sentAt: now,
    };

    studentQuestions.push(entry);
    if (studentQuestions.length > MAX_STORED_STUDENT_QUESTIONS) {
      studentQuestions.splice(0, studentQuestions.length - MAX_STORED_STUDENT_QUESTIONS);
    }
    saveStudentQuestions();
    studentQuestionCooldown.set(sd.id, now);

    // Broadcast so any open teacher dashboard sees it live — students don't
    // listen for this event, so it's harmless for it to reach every socket.
    io.emit("student-question", entry);

    console.log(`❓ Question from ${session.name} (${sd.id}): "${cleanMessage}"`);
    socket.emit("student-message-sent", { sentAt: now });
  });

  // ── Admin: fetch the full log of student questions (loads when the
  // "Questions" panel is opened on the dashboard) ─────────────────────────
  socket.on("get-student-questions", ({ password } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("student-questions-failed", { message: "Incorrect password." });
    }
    const sorted = studentQuestions.slice().sort((a, b) => b.sentAt - a.sentAt);
    socket.emit("student-questions-list", sorted);
  });

  // ── Admin: pause/resume ALL live students at once (optionally scoped to
  // one section) — same lockout mechanism as the individual toggle above,
  // just applied in bulk. Students who have already submitted are skipped. ──
  socket.on("admin-pause-all-students", ({ paused, section } = {}) => {
    const isPaused = Boolean(paused);
    let affected = 0;

    for (const [studentId, session] of activeSessions.entries()) {
      if (session.status === "submitted") continue;
      if (section && session.section !== section) continue;

      session.paused = isPaused;
      affected++;

      const targetSocket = io.sockets.sockets.get(session.socketId);
      if (targetSocket && targetSocket.studentData) {
        targetSocket.studentData.paused = isPaused;
        targetSocket.emit("paused-state", {
          paused:  isPaused,
          message: isPaused
            ? "Di magpalabi banha. 1 Minute di pa ka ka.pindot."
            : "You may continue answering.",
        });
      }

      if (studentSessions.has(studentId)) {
        studentSessions.get(studentId).paused = isPaused;
      }
    }

    if (affected > 0) saveInProgressSessions();
    broadcastActiveSessions();

    console.log(`${isPaused ? "⏸ " : "▶️ "}${affected} live student(s) ${isPaused ? "paused" : "resumed"} by admin${section ? ` (section: ${section})` : " (all sections)"}`);
    socket.emit("pause-all-success", { paused: isPaused, section: section || null, count: affected });
  });

  // ── Admin: get full results (with answer detail) ─────────────────────────
  socket.on("get-full-results", ({ password } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("full-results-error", { message: "Incorrect password." });
    }
    socket.emit("full-results", { submissions });
  });

  // ── Admin: toggle quiz open/closed ──────────────────────────────────────
  socket.on("admin-toggle-quiz", ({ password, open, sectionKey: rawKey } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("toggle-quiz-failed", { message: "Incorrect password." });
    }
    const key = resolveAdminKey(rawKey);
    if (!key) return socket.emit("toggle-quiz-failed", { message: "Pick a section–subject first." });
    const exam = getExam(key);
    exam.open = Boolean(open);
    broadcastExamStatus();
    console.log(`🔒 ${key} ${exam.open ? "OPENED" : "LOCKED"} by admin`);
    socket.emit("toggle-quiz-success", { sectionKey: key, open: exam.open });
  });

  // ── Admin: set exam type (what students see: "Quiz", "Summative Test", or "Term Examination") ─
  socket.on("admin-set-exam-type", ({ password, examType, sectionKey: rawKey } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("set-exam-type-failed", { message: "Incorrect password." });
    }
    const key = resolveAdminKey(rawKey);
    if (!key) return socket.emit("set-exam-type-failed", { message: "Pick a section–subject first." });
    const exam = getExam(key);
    exam.examType = normalizeExamType(examType);
    saveExams();
    broadcastExamStatus();
    console.log(`✏️  Exam type for ${key} set to: ${exam.examType}`);
    socket.emit("set-exam-type-success", { sectionKey: key, examType: exam.examType });
  });

  // ── Admin: set exam duration (minutes) — applies to future logins ────────
  // Students who are already mid-quiz keep the duration that was in effect
  // when they logged in (captured on their session as durationMs), so
  // changing this never cuts short or extends a test already in progress.
  socket.on("admin-set-quiz-duration", ({ password, minutes, sectionKey: rawKey } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("set-quiz-duration-failed", { message: "Incorrect password." });
    }
    const n = Number(minutes);
    if (!Number.isFinite(n) || n < MIN_QUIZ_DURATION_MINUTES || n > MAX_QUIZ_DURATION_MINUTES) {
      return socket.emit("set-quiz-duration-failed", {
        message: `Enter a duration between ${MIN_QUIZ_DURATION_MINUTES} and ${MAX_QUIZ_DURATION_MINUTES} minutes.`,
      });
    }
    const key = resolveAdminKey(rawKey);
    if (!key) return socket.emit("set-quiz-duration-failed", { message: "Pick a section–subject first." });
    const exam = getExam(key);
    exam.durationMinutes = Math.round(n);
    saveExams();
    broadcastExamStatus();
    console.log(`⏱  Exam duration for ${key} set to ${exam.durationMinutes} minute(s) by admin`);
    socket.emit("set-quiz-duration-success", { sectionKey: key, minutes: exam.durationMinutes });
  });

  // ── Admin: toggle whether students can see their score/review ────────────
  socket.on("admin-toggle-results", ({ password, visible } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("toggle-results-failed", { message: "Incorrect password." });
    }
    resultsVisible = Boolean(visible);
    io.emit("results-status", { visible: resultsVisible });
    console.log(`👁  Results ${resultsVisible ? "SHOWN" : "HIDDEN"} to students by admin`);
    socket.emit("toggle-results-success", { visible: resultsVisible });

    // If just turned ON, push results to already-submitted students who are still connected
    if (resultsVisible) {
      for (const [, s] of io.sockets.sockets) {
        if (s.studentData && s.studentData.submitted && s.studentData.pendingReview && !s.studentData.resultsSent) {
          s.emit("submission-received", { ...s.studentData.pendingReview, resultsVisible: true });
          s.studentData.resultsSent = true;
        }
      }
    }
  });

  // ── Admin: enable/disable a subject-section ──────────────────────────────
  // Enable/disable is per subject-section (e.g. "RIZAL-MATH"), not per whole
  // section — every subject-section starts disabled by default, and a
  // teacher opts individual ones in from the dashboard's Sections tab.
  // Disabling one hides it from the student login page's subject choices
  // (and hides the raw section entirely once all its subjects are disabled)
  // and blocks any login attempt for it, even if the request is sent
  // directly to the socket. Re-enabling reverses both.
  socket.on("admin-toggle-section", ({ password, sectionKey: rawSectionKey, enabled } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("section-toggle-failed", { message: "Incorrect password." });
    }
    const normalizedKey = String(rawSectionKey || "").trim().toUpperCase();
    if (!ALL_SECTION_SUBJECT_KEYS.includes(normalizedKey)) {
      return socket.emit("section-toggle-failed", { message: "Unknown section/subject." });
    }

    const isEnabled = ENABLED_SECTIONS.includes(normalizedKey);
    if (Boolean(enabled) === isEnabled) {
      // Already in the requested state — no-op, just confirm.
      return socket.emit("section-toggle-success", { sectionKey: normalizedKey, enabled: isEnabled });
    }

    if (enabled) {
      ENABLED_SECTIONS.push(normalizedKey);
    } else {
      ENABLED_SECTIONS = ENABLED_SECTIONS.filter(k => k !== normalizedKey);
    }
    saveEnabledSections();

    console.log(`📚 Section/subject "${normalizedKey}" ${enabled ? "ENABLED" : "DISABLED"} by admin`);
    io.emit("enabled-sections-update", ENABLED_SECTIONS);
    io.emit("roster-update", getAvailableRoster());
    socket.emit("section-toggle-success", { sectionKey: normalizedKey, enabled: Boolean(enabled) });
  });

  // ── Admin: get current item point values (for the Points editor) ─────────
  socket.on("admin-get-points", ({ password, sectionKey: rawKey } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("points-error", { message: "Incorrect password." });
    }
    const key = resolveAdminKey(rawKey);
    if (!key) return socket.emit("points-error", { message: "Pick a section–subject first." });
    const exam = getExam(key);
    socket.emit("points-data", {
      sectionKey: key,
      questions: exam.questions.map(q => ({ num: q.num, q: q.q })),
      points:    exam.questions.reduce((acc, q) => { acc[q.num] = getPoints(q.num, exam); return acc; }, {}),
      maxScore:  getMaxScore(exam),
    });
  });

  // ── Admin: set item point values ──────────────────────────────────────────
  socket.on("admin-set-points", ({ password, points, sectionKey: rawKey } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("points-error", { message: "Incorrect password." });
    }
    const key = resolveAdminKey(rawKey);
    if (!key) return socket.emit("points-error", { message: "Pick a section–subject first." });
    const exam = getExam(key);
    if (!points || typeof points !== "object") {
      return socket.emit("points-error", { message: "Invalid points data." });
    }

    const validNums = new Set(exam.questions.map(q => q.num));
    const updated = {};
    for (const [key, val] of Object.entries(points)) {
      const num = Number(key);
      const pts = Number(val);
      if (!validNums.has(num)) {
        return socket.emit("points-error", { message: `Item ${key} does not exist.` });
      }
      if (!Number.isFinite(pts) || pts <= 0 || pts > 100) {
        return socket.emit("points-error", { message: `Item ${key} needs a point value between 1 and 100.` });
      }
      updated[num] = pts;
    }

    // Every item must have a value
    for (const num of validNums) {
      if (!(num in updated)) {
        return socket.emit("points-error", { message: `Item ${num} is missing a point value.` });
      }
    }

    exam.points = updated;
    saveExams();

    const maxScore = getMaxScore(exam);
    console.log(`🎯 Item points for ${key} updated by admin | New max score: ${maxScore}`);
    broadcastExamStatus();
    socket.emit("points-set-success", { sectionKey: key, points: exam.points, maxScore });
  });

  // ── Admin: get absent (not-started) students ─────────────────────────────
  socket.on("get-absent-students", ({ password } = {}) => {
    if (password !== RESET_PASSWORD) {
      return socket.emit("absent-students-error", { message: "Incorrect password." });
    }
    const startedIds = new Set([
      ...Array.from(activeSessions.keys()),
      ...submissions.map(s => s.studentId),
    ]);
    const absent = studentList
      .filter(s => !startedIds.has(s.id))
      .map(s => ({ id: s.id, name: s.name, section: s.section }));
    socket.emit("absent-students", { absent });
  });

  // ── Disconnect cleanup ────────────────────────────────────────────────────
  socket.on("disconnect", (reason) => {
    loginAttempts.delete(socket.id);
    if (socket.studentData && !socket.studentData.submitted) {
      console.log(`🔌 Disconnected (unsubmitted): ${socket.studentData.name} | Reason: ${reason}`);
      if (activeSessions.has(socket.studentData.id)) {
        activeSessions.get(socket.studentData.id).status = "disconnected";
        broadcastActiveSessions();
        broadcastRoster();
      }
    }
  });
});

// Periodically snapshot in-progress sessions to disk (so tab-switch/paste
// counts stay reasonably fresh even if the server is restarted) and drop any
// session whose time has fully run out, since it can no longer be resumed.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, sd] of studentSessions.entries()) {
    const sdDurationMs = sd.durationMs ?? getQuizDurationMs();
    if ((now - sd.startTime) > sdDurationMs + GRACE_PERIOD_MS) {
      studentSessions.delete(id);
      changed = true;
    }
  }
  saveInProgressSessions();
  if (changed) console.log("🧹 Cleared expired in-progress session(s)");
}, 60_000);

// Server-side time-up backstop. The client already auto-submits itself when
// its local countdown hits zero, but that timer can misfire — a backgrounded
// tab gets throttled by the browser, the page loses focus, or a client bug —
// so this checks every connected, not-yet-submitted student against the
// server's own clock and pushes the same "force-submit" signal the moment
// their allotted time is up. Runs far more often than the cleanup sweep above
// so students get cut off close to on time rather than up to a minute late.
const TIME_UP_CHECK_MS = 5_000;
setInterval(() => {
  const now = Date.now();
  for (const [, sock] of io.sockets.sockets) {
    const sd = sock.studentData;
    if (!sd || sd.submitted || sd.timeUpNotified) continue;
    const sdDurationMs = sd.durationMs ?? getQuizDurationMs();
    if ((now - sd.startTime) >= sdDurationMs) {
      sd.timeUpNotified = true;
      sd.autoSubmitted = true;
      console.log(`⏰ Time up — auto-submitting ${sd.name} (${sd.id})`);
      sock.emit("force-submit", { reason: "Time is up!" });
    }
  }
}, TIME_UP_CHECK_MS);

// ── State helpers ─────────────────────────────────────────────────────────────
function getCurrentState() {
  // Every submission is graded against ITS OWN exam (by gradeSection), so Math 7
  // and Science 8 never blend into one item analysis.
  const sizeFor = sub => (examsByKey.get(sub.gradeSection)?.questions.length) || sub.totalItems || 0;
  const perKey = {};
  const keys = new Set([...examsByKey.keys(), ...submissions.map(s => s.gradeSection)]);
  for (const key of keys) {
    const exam = examsByKey.get(key);
    if (!exam) continue;
    const subs = submissions.filter(s => s.gradeSection === key);
    perKey[key] = {
      itemCount:  exam.questions.length,
      maxScore:   getMaxScore(exam),
      itemTopics: exam.questions.map(q => q.competency || q.topic || "General"),
      stats:      calculateStats(subs, exam.questions.length),
      open:       exam.open,
      examType:   exam.examType,
      durationMinutes: exam.durationMinutes,
    };
  }
  // Legacy top-level fields: kept so older dashboard code keeps working. They
  // describe the single key that has submissions (or the largest exam otherwise).
  const subKeys = [...new Set(submissions.map(s => s.gradeSection))];
  const legacyKey = subKeys.length === 1 ? subKeys[0] : null;
  const legacyExam = (legacyKey && examsByKey.get(legacyKey)) || null;
  const legacySize = legacyExam ? legacyExam.questions.length : Math.max(0, ...Object.values(perKey).map(k => k.itemCount));
  return {
    submissions: submissions.map(s => ({
      studentId:     s.studentId,
      name:          s.name,
      gradeSection:  s.gradeSection,
      score:         s.score,
      maxScore:      s.maxScore ?? s.totalItems,
      percentage:    s.percentage,
      totalItems:    s.totalItems,
      tabSwitches:   s.tabSwitches ?? 0,
      pasteFlags:    s.pasteFlags ?? 0,
      autoSubmitted: s.autoSubmitted ?? false,
      timestamp:     s.timestamp,
      durationMs:    s.durationMs ?? 0,
      answers:       s.answers.map(x => (x ? 1 : 0)),
      // itemCorrect[i] = true/false for original question num (i+1), sized to THIS submission's exam
      itemCorrect:   buildItemCorrect(s, sizeFor(s)),
    })),
    exams:          perKey,
    stats:          calculateStats(submissions, legacySize),
    meanPercentage: calculateMeanPercentage(),
    itemCount:      legacySize,
    maxScore:       legacyExam ? getMaxScore(legacyExam) : 0,
    // Learning Competencies column for the DepEd-style Item Analysis print/export (legacy, single-exam view).
    itemTopics:     legacyExam ? legacyExam.questions.map(q => q.competency || q.topic || "General") : [],
  };
}

// Build a boolean array [q1correct, q2correct, ...] aligned to the exam's
// question order (question num 1..size)
function buildItemCorrect(submission, size) {
  size = size ?? (examsByKey.get(submission.gradeSection)?.questions.length) ?? submission.totalItems ?? 0;
  const result = new Array(size).fill(false);

  if (!Array.isArray(submission.questionMap)) {
    return result;
  }

  for (const item of submission.questionMap) {
    const idx = item.num - 1; // question num is 1-based
    if (idx >= 0 && idx < size) {
      result[idx] = item.isCorrect === true;
    }
  }
  return result;
}

// Item analysis for ONE set of submissions that all took the same exam.
function calculateStats(subs = submissions, size = 0) {
  const n = subs.length;
  if (n === 0) return { difficulty: [], overallDifficultyIndex: 0, upperGroup: [], lowerGroup: [], correctCounts: [], groupSize: 0 };

  const matrix = subs.map(s => buildItemCorrect(s, size));

  // Count total correct per item (B)
  const correct = new Array(size).fill(0);
  matrix.forEach(row => row.forEach((c, i) => { if (c) correct[i]++; }));

  // Sort students by score descending for U/L grouping
  const k27 = Math.max(1, Math.round(n * 0.27));
  const sorted = matrix
    .map((row, i) => ({ row, score: subs[i].score }))
    .sort((a, b) => b.score - a.score);

  const upperRows = sorted.slice(0, k27).map(x => x.row);
  const lowerRows = sorted.slice(n - k27).map(x => x.row);

  // Count correct per item in upper and lower groups
  const upperGroup = new Array(size).fill(0);
  const lowerGroup = new Array(size).fill(0);
  upperRows.forEach(row => row.forEach((c, i) => { if (c) upperGroup[i]++; }));
  lowerRows.forEach(row => row.forEach((c, i) => { if (c) lowerGroup[i]++; }));

  const difficulty = correct.map(c => Number(((c / n) * 100).toFixed(1)));
  const overallDifficultyIndex = difficulty.length
    ? Number((difficulty.reduce((a, b) => a + b, 0) / difficulty.length).toFixed(1))
    : 0;

  return { difficulty, overallDifficultyIndex, upperGroup, lowerGroup, correctCounts: correct, groupSize: k27, totalStudents: n };
}

function calculateMeanPercentage() {
  if (submissions.length === 0) return 0;
  const sum = submissions.reduce((acc, s) => acc + (Number(s.percentage) || 0), 0);
  return Number((sum / submissions.length).toFixed(2));
}

// ── Start ─────────────────────────────────────────────────────────────────────
const os = require("os");

function getLanIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      // Skip loopback and non-IPv4
      if (net.family === "IPv4" && !net.internal) {
        return net.address;
      }
    }
  }
  return "YOUR_COMPUTER_IP";
}

server.listen(PORT, "0.0.0.0", () => {
  beacon.startBeacon(PORT, "Teacher");
  const lan = getLanIp();

  // Centers a line of text in the current terminal window. Falls back to a
  // sane default width if the terminal size isn't reported (e.g. some log
  // redirections), and ignores ANSI color codes when measuring length so
  // colored lines don't get mis-centered.
  function centerLine(str = "") {
    if (!str) return "";
    const width = process.stdout.columns || 100;
    const visible = str.replace(/\x1b\[[0-9;]*m/g, "");
    const pad = Math.max(0, Math.floor((width - visible.length) / 2));
    return " ".repeat(pad) + str;
  }

  const bannerLines = [
    "",
    "╔═══════════════════════════════════════════════════════╗",
    "║        GUADALUPE NATIONAL HIGH SCHOOL — QUIZ SYSTEM       ║",
    "║                                                           ║",
    "║   Created by: JULIUS CELIO                               ║",
    "║   © Julius Celio — All Rights Reserved                   ║",
    "║   Intellectual Property of Julius Celio                  ║",
    "║   For exclusive use of Guadalupe NHS — NOT FOR SALE       ║",
    "╚═══════════════════════════════════════════════════════╝",
    "",
    "\x1b[1m\x1b[33m🚀 Nidagan na ag server, pwed nane nemu gamiton bisan offline, basta ma.connected laman tanan sa same Modem\x1b[0m",
    "",
    "┌───────────────────────────────────────────────────────────────┐",
    "│  📡 Mao ne nga URL/IP address nga emu i.share sa estudyante.  │",
    "│                                                               │",
    `│  🎓 Student Quiz :  http://${lan}:${PORT}            `,
    `│  📊 Dashboard    :  http://${lan}:${PORT}/dashboard   `,
    "└───────────────────────────────────────────────────────────────┘",
    "",
  ];

  bannerLines.forEach(line => console.log(line ? centerLine(line) : ""));
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Flush everything to disk one last time when the process is asked to stop
// (Ctrl+C, "npm start" window closed, or the OS sending SIGTERM/SIGHUP during
// a shutdown/logout). This is a belt-and-suspenders companion to the atomic
// writes above — atomic writes stop corruption if the process dies mid-write,
// this handler tries to make sure the LATEST state is actually written at all
// before the process disappears, rather than relying only on whatever the
// last event handler happened to save.
let shuttingDown = false;

// Writes every in-memory data set to disk. Used by the shutdown handler AND by
// the dashboard's Save button (via POST /api/save-now), so both do exactly the same thing.
function flushAll() {
  const steps = [
    ["quiz-data.json", saveData],
    ["quiz-archive.json", saveArchive],
    ["in-progress-sessions.json", saveInProgressSessions],
    ["points.json", savePoints],
    ["exams.json", saveExams],
    ["item-bank.json", saveItemBank],
    ["question-history.json", saveQuestionHistory],
    ["student-questions.json", saveStudentQuestions],
    ["exam-type.json", saveExamType],
  ];
  const failed = [];
  for (const [name, fn] of steps) {
    try { fn(); } catch (e) { failed.push(name); console.error(`Failed to save ${name}:`, e.message); }
  }
  return failed;
}

function shutdownGracefully(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n🛑 Received ${signal} — saving all data before exit...`);
  flushAll();
  console.log("✅ Data saved. Shutting down.");
  process.exit(0);
}
process.on("SIGINT", () => shutdownGracefully("SIGINT"));   // Ctrl+C
process.on("SIGTERM", () => shutdownGracefully("SIGTERM")); // shutdown/logout/kill
process.on("SIGHUP", () => shutdownGracefully("SIGHUP"));   // terminal window closed
