/**
 * ═══════════════════════════════════════════════════════════════
 *   LICENSE LOCK — GNHS Quiz System
 *   Copyright (c) Julius Celio. All Rights Reserved.
 *
 *   This file locks the quiz server to specific, pre-authorized
 *   machines. Do not remove or modify — doing so is what this
 *   protection is meant to prevent.
 *
 *   v3: the list of approved machines (allowlist.json) is SIGNED
 *   with a PRIVATE key that only the author holds. This file
 *   contains only the PUBLIC key, which can check a list but can
 *   never create one. The list is bundled with the app AND
 *   downloaded from GitHub by the updater, so approving or
 *   cancelling a machine never needs a new app version.
 *
 *   v4: THREE checks must all pass —
 *     1) this machine's ID is on the signed allowlist,
 *     2) its approval has not expired (date is signed in the list),
 *     3) the teacher has a LICENSE KEY issued by the author for
 *        this exact machine ID (a secret, unlike the public list).
 *   The key is stored in license.key (data folder). It is the same
 *   signature the old license.key used, so old key files still work.
 * ═══════════════════════════════════════════════════════════════
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const https = require("https");
const { execSync } = require("child_process");
const DATA_DIR = process.env.GNHS_DATA_DIR || __dirname;

// Paste the PUBLIC key printed by:  node make-license.js init
// (the whole block, including the BEGIN/END lines). It is safe to commit.
const PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAKK+r3ZINqQFuFxBDUcK+LbzN+cZSsm3m+ripw562DZw=
-----END PUBLIC KEY-----`;

// What gets signed. Must match make-license.js.
const SIGN_PREFIX = "GNHS-LICENSE-v2|";

// ── Allowlist settings ───────────────────────────────────────────────────────
// What gets signed for the allowlist. Must match admin/manage-allowlist.js.
const ALLOWLIST_PREFIX = "GNHS-ALLOWLIST-v1|";
// v2 lists also sign each machine's EXPIRY DATE (sig2), so the date can't be edited.
// The old signature (sig) is still written so apps installed before expiry existed keep working.
const ALLOWLIST_PREFIX_V2 = "GNHS-ALLOWLIST-v2|";
// Lists signed before expiry existed (v1 only, no sig2) are accepted ONLY if issued at or
// before this moment. Without this, someone could strip sig2 from a new list to remove expiry dates.
const LEGACY_LIST_CUTOFF = "2026-11-18T03:57:43.081Z";
// How many days before expiry the teacher starts seeing a reminder.
const WARN_DAYS = 30;
// Where the updater downloads the newest signed list (a permanent GitHub release
// that the "Publish allowlist" workflow keeps up to date).
const ALLOWLIST_URL = "https://github.com/juliuscelio-del/quiz_server/releases/download/allowlist/allowlist.json";
// Copy that ships inside the app build (so a fresh install works at once)...
const BUNDLED_ALLOWLIST = path.join(__dirname, "allowlist.json");
// ...and the copy the app downloads later, kept in the data folder (survives app updates).
const CACHED_ALLOWLIST = path.resolve(DATA_DIR, "allowlist.json");

/**
 * A stable hardware identifier for this machine.
 * Deliberately does NOT use MAC address or hostname — macOS rotates
 * Wi-Fi MACs per network (Private Wi-Fi Address) and can rename the
 * hostname on conflict, both of which broke the old ID scheme every
 * time the network changed.
 */
function getHardwareId() {
  const platform = os.platform();

  try {
    if (platform === "darwin") {
      // macOS: IOPlatformUUID never changes for the life of the machine.
      const out = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
        { encoding: "utf8" }
      );
      const match = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
      if (match) return match[1];
    } else if (platform === "win32") {
      // Windows: MachineGuid from the registry.
      const out = execSync(
        'reg query HKLM\\SOFTWARE\\Microsoft\\Cryptography /v MachineGuid',
        { encoding: "utf8" }
      );
      const match = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]+)/);
      if (match) return match[1];
    } else if (platform === "linux") {
      // Linux: /etc/machine-id is stable per install.
      if (fs.existsSync("/etc/machine-id")) {
        const id = fs.readFileSync("/etc/machine-id", "utf8").trim();
        if (id) return id;
      }
    }
  } catch (e) {
    // Fall through to the cached-UUID fallback below.
  }

  // Fallback for anything the above couldn't read: generate a random
  // UUID once and cache it next to this file, so it stays stable
  // across restarts even though it isn't hardware-derived.
  const cachePath = path.resolve(DATA_DIR, ".machine-id-cache");
  if (fs.existsSync(cachePath)) {
    return fs.readFileSync(cachePath, "utf8").trim();
  }
  const fallbackId = crypto.randomUUID();
  fs.writeFileSync(cachePath, fallbackId);
  return fallbackId;
}

/** Public machine ID used for licensing — a hash of the hardware ID. */
function getMachineId() {
  const hwId = getHardwareId();
  return crypto.createHash("sha256").update(hwId).digest("hex").slice(0, 24);
}

const LICENSE_FILE = path.resolve(DATA_DIR, "license.key");

// ── Allowlist: read, verify, download ────────────────────────────────────────

/** The text that is signed for a v2 list: every ID together with its expiry date. */
function v2Payload(issuedAt, machines) {
  const entries = machines.map((m) => m.id + "@" + (m.expiresAt || "never")).sort();
  return ALLOWLIST_PREFIX_V2 + issuedAt + "|" + entries.join(",");
}

function sigOk(payload, sig) {
  return crypto.verify(null, Buffer.from(payload), crypto.createPublicKey(PUBLIC_KEY), Buffer.from(String(sig), "base64"));
}

/** Reads a list file and returns it ONLY if its signature is valid, else null. */
function readAllowlist(file) {
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!list || !Array.isArray(list.machines) || !list.issuedAt || !list.sig) return null;
    if (!list.machines.every((m) => m && typeof m.id === "string")) return null;
    if (!Number.isFinite(Date.parse(list.issuedAt))) return null;
    if (!list.machines.every((m) => m.expiresAt === undefined || Number.isFinite(Date.parse(m.expiresAt)))) return null;

    // v2: IDs + expiry dates are signed together.
    if (list.sig2) {
      return sigOk(v2Payload(list.issuedAt, list.machines), list.sig2) ? list : null;
    }
    // Old v1 list (IDs only, never expires) — only the lists that existed before expiry was added.
    if (Date.parse(list.issuedAt) > Date.parse(LEGACY_LIST_CUTOFF)) return null;
    const ids = list.machines.map((m) => m.id).sort();
    return sigOk(ALLOWLIST_PREFIX + list.issuedAt + "|" + ids.join(","), list.sig) ? list : null;
  } catch (e) {
    return null;
  }
}

/** Newest valid list wins, so an old list can't be swapped in to "un-cancel" someone. */
function bestAllowlist() {
  const lists = [readAllowlist(BUNDLED_ALLOWLIST), readAllowlist(CACHED_ALLOWLIST)].filter(Boolean);
  lists.sort((a, b) => Date.parse(b.issuedAt) - Date.parse(a.issuedAt));
  return lists[0] || null;
}

/** GET a URL as text, following GitHub's redirects. Resolves null on any problem. */
function fetchText(url, hops = 4) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: 8000, headers: { "User-Agent": "GNHS-Quiz-Teacher" } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location && hops > 0) {
        res.resume();
        return resolve(fetchText(res.headers.location, hops - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return resolve(null); }
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve(body));
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => req.destroy());
  });
}

/**
 * Downloads the latest signed list and keeps it ONLY if the signature is valid
 * and it is newer than what we already have. Returns true if a newer list was saved.
 */
async function refreshAllowlist() {
  if (!ALLOWLIST_URL) return false;
  const body = await fetchText(ALLOWLIST_URL);
  if (!body) return false;
  const tmp = CACHED_ALLOWLIST + ".tmp";
  try {
    fs.writeFileSync(tmp, body);
    const incoming = readAllowlist(tmp);
    const current = bestAllowlist();
    if (incoming && (!current || Date.parse(incoming.issuedAt) > Date.parse(current.issuedAt))) {
      fs.renameSync(tmp, CACHED_ALLOWLIST);
      return true;
    }
  } catch (e) {
    // fall through to cleanup
  }
  try { fs.unlinkSync(tmp); } catch (e) {}
  return false;
}

// ── Expiry ───────────────────────────────────────────────────────────────────

const CLOCK_FILE = path.resolve(DATA_DIR, ".clock-guard");
const DAY_MS = 86400000;

/**
 * "Now", protected against turning the computer's clock back to dodge an expiry date.
 * It is never earlier than (a) the newest signed list's issue date or (b) the latest
 * date this app has seen before.
 */
function trustedNow(list) {
  let now = Date.now();
  try {
    if (list) now = Math.max(now, Date.parse(list.issuedAt));
    let seen = 0;
    try { seen = Number(fs.readFileSync(CLOCK_FILE, "utf8")) || 0; } catch (e) {}
    now = Math.max(now, seen);
    // Only remember dates that make sense (within a year of the list), so one wrong clock
    // that is set far into the future cannot lock a computer out forever.
    if (now > seen && (!list || now <= Date.parse(list.issuedAt) + 366 * DAY_MS)) {
      fs.writeFileSync(CLOCK_FILE, String(now));
    }
  } catch (e) {}
  return now;
}

/**
 * Full license state for this computer:
 *   { state: "ok" | "expiring" | "expired" | "not-listed" | "no-key" | "bad-key",
 *     expiresAt, daysLeft, machineId }
 */
function getLicenseStatus() {
  const machineId = getMachineId();
  const list = bestAllowlist();
  let st;
  if (list) {
    const entry = list.machines.find((m) => m.id === machineId);
    if (!entry) return { state: "not-listed", machineId };
    if (!entry.expiresAt) st = { state: "ok", machineId, expiresAt: null, daysLeft: null };
    else {
      const msLeft = Date.parse(entry.expiresAt) - trustedNow(list);
      const daysLeft = Math.ceil(msLeft / DAY_MS);
      if (msLeft <= 0) return { state: "expired", machineId, expiresAt: entry.expiresAt, daysLeft: 0 };
      st = { state: daysLeft <= WARN_DAYS ? "expiring" : "ok", machineId, expiresAt: entry.expiresAt, daysLeft };
    }
  } else {
    st = { state: "ok", machineId, expiresAt: null, daysLeft: null };   // no list yet: the key alone decides
  }
  // Check 3: license key. Reported separately so the app can ask for it.
  const ks = keyState();
  if (ks !== "ok") return { ...st, state: ks };
  return st;
}

/** "Mon, 30 Jun 2027" in Philippine time. */
function formatDate(iso) {
  try {
    return new Date(iso).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", day: "numeric", month: "long", year: "numeric" });
  } catch (e) { return String(iso); }
}

/** False when a valid allowlist exists and this machine is NOT on it, or its license has expired. */
function isStillAllowed() {
  const st = getLicenseStatus();
  return st.state !== "not-listed" && st.state !== "expired";
}

// ── License key (check 3) ────────────────────────────────────────────────────

// Keys are shown to people as  GNHS-XXXXX-XXXXX-…  (base32 of the signature).
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeKey(text) {
  const clean = String(text || "").toUpperCase().replace(/^\s*GNHS[-\s]*/, "").replace(/[^A-Z2-7]/g, "");
  if (clean.length < 100) return null;
  let bits = 0, value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out).slice(0, 64);
}

/** Signature must be valid for THIS machine's ID (so a key can't be copied to another computer). */
function keySigIsValid(machineId, sigBuf) {
  try {
    return crypto.verify(null, Buffer.from(SIGN_PREFIX + machineId), crypto.createPublicKey(PUBLIC_KEY), sigBuf);
  } catch (e) { return false; }
}

/** Reads license.key (new text key, or the old JSON file). Returns { sig, label } or { error }. */
function readLicenseKey() {
  let raw;
  try { raw = fs.readFileSync(LICENSE_FILE, "utf8").trim(); }
  catch (e) { return { error: "missing" }; }
  if (!raw) return { error: "missing" };
  try {
    if (raw.startsWith("{")) {                       // old format: { machineId, sig2, label }
      const d = JSON.parse(raw);
      if (!d || !d.sig2 || (d.machineId && d.machineId !== getMachineId())) return { error: "invalid" };
      return { sig: Buffer.from(String(d.sig2), "base64"), label: d.label };
    }
    const sig = decodeKey(raw);
    return sig && sig.length === 64 ? { sig } : { error: "invalid" };
  } catch (e) { return { error: "invalid" }; }
}

/** "ok" | "no-key" | "bad-key" for this computer. */
function keyState() {
  const k = readLicenseKey();
  if (k.error === "missing") return "no-key";
  if (k.error || !keySigIsValid(getMachineId(), k.sig)) return "bad-key";
  return "ok";
}

/** Called when a teacher pastes a key. Saves it only if it is valid for this computer. */
function installKey(text) {
  const sig = decodeKey(text);
  if (!sig || sig.length !== 64 || !keySigIsValid(getMachineId(), sig)) {
    return { ok: false, reason: "That license key is not valid for this computer. Check it was copied completely." };
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(LICENSE_FILE, String(text).trim() + "\n");
  } catch (e) {
    return { ok: false, reason: "Could not save the key: " + e.message };
  }
  return { ok: true };
}

// ── App code key (the "sealed app") ─────────────────────────────────────────
// The allowlist entry of each machine carries `wk`: the app's code key, locked with a key made from
// this machine's ID + its license key. Only that machine, with that key, can unlock it.

function deriveWrapKey(machineId, sigBuf) {
  return crypto.createHash("sha256").update("GNHS-WRAP-v1|" + machineId + "|").update(sigBuf).digest();
}

/** The key that decrypts the app's code, or null if this computer isn't allowed to have it. */
function getAppKey() {
  try {
    const st = getLicenseStatus();
    if (st.state !== "ok" && st.state !== "expiring") return null;   // expired / not listed / no key
    const machineId = getMachineId();
    const list = bestAllowlist();
    const entry = list && list.machines.find((m) => m.id === machineId);
    const k = readLicenseKey();
    if (!entry || !entry.wk || k.error) return null;
    const wk = Buffer.from(String(entry.wk), "base64");
    const d = crypto.createDecipheriv("aes-256-gcm", deriveWrapKey(machineId, k.sig), wk.slice(0, 12));
    d.setAuthTag(wk.slice(12, 28));
    return Buffer.concat([d.update(wk.slice(28)), d.final()]);
  } catch (e) {
    return null;
  }
}

/**
 * Runs all three checks. Returns the status object from getLicenseStatus() with
 * state "ok" or "expiring" only when everything passes.
 */
function checkLicense() {
  const machineId = getMachineId();
  const status = getLicenseStatus();

  // Checks 1 + 2: allowlist and expiry.
  if (status.state === "not-listed") {
    printLockedMessage(machineId, "This machine is not on the approved list.");
    process.exit(1);
  }
  if (status.state === "expired") {
    printLockedMessage(machineId, `This license expired on ${formatDate(status.expiresAt)}. Ask Julius Celio to renew it.`);
    process.exit(1);
  }
  // Check 3: the license key (also the only check when no list exists yet).
  if (status.state === "no-key") {
    printLockedMessage(machineId, "No license key found. Ask Julius Celio for your license key and paste it when the app asks.");
    process.exit(1);
  }
  if (status.state === "bad-key") {
    printLockedMessage(machineId, "The license key is not valid for this computer. Ask Julius Celio for a new one.");
    process.exit(1);
  }

  const until = status.expiresAt ? `, valid until ${formatDate(status.expiresAt)}` : "";
  console.log(`✔ License OK (machine ${machineId.slice(0, 8)}…)${until}`);
  if (status.state === "expiring") {
    console.warn(`⚠ License expires in ${status.daysLeft} day(s) — contact Julius Celio to renew.`);
  }
}

function printLockedMessage(machineId, reason) {
  console.error("\n═══════════════════════════════════════════════════════");
  console.error("  🔒  GNHS QUIZ SYSTEM — UNLICENSED MACHINE");
  console.error("═══════════════════════════════════════════════════════");
  console.error(`  Reason: ${reason}`);
  console.error(`  This machine's ID: ${machineId}`);
  console.error("");
  console.error("  Send this ID to Julius Celio to get this device approved, renewed or given a license key.");
  console.error("  The server will not start without it.");
  console.error("═══════════════════════════════════════════════════════\n");
}

module.exports = { checkLicense, getMachineId, refreshAllowlist, isStillAllowed, getLicenseStatus, formatDate, installKey, getAppKey };
