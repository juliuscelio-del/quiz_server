#!/usr/bin/env node
/**
 * Manage the list of machines allowed to run GNHS Quiz Teacher.
 * FOR JULIUS ONLY — never ship this folder inside the app.
 *
 *   node admin/manage-allowlist.js init                    (ONE TIME: creates your signing key)
 *   node admin/manage-allowlist.js add <machineId> "Teacher name" [--expires YYYY-MM-DD | --days N | --never]
 *   node admin/manage-allowlist.js import teachers.txt [--expires ... | --days N | --never]
 *   node admin/manage-allowlist.js renew <machineId|all> [--expires YYYY-MM-DD | --days N | --never]
 *   node admin/manage-allowlist.js remove <machineId>      (first 6+ characters are enough)
 *   node admin/manage-allowlist.js key <machineId|all>     (prints the teacher's LICENSE KEY; "all" also saves admin/license-keys.txt)
 *   node admin/manage-allowlist.js publish                 (re-sign the list as it is — do this after "seal")
 *   node admin/manage-allowlist.js list                    (shows each expiry date)
 *
 * License key: the 3rd lock. A machine must be on the list, not expired, AND the teacher must paste the
 * key made for THEIR machine ID (the app asks once, then remembers). Send each teacher only their own key.
 *
 * Expiry: every approval can expire. With no option, a new machine gets DEFAULT_DAYS (365 days).
 * "--expires 2027-06-30" lasts until the END of that day (Philippine time). "--never" = no expiry.
 * To extend a teacher before the date, run "renew" and upload the list — no new app needed.
 *
 * Files:
 *   admin/machines.json      your master list (IDs + names)   — keep private, back it up
 *   admin/private-key.pem    your signing key                 — keep private, back it up
 *   server/allowlist.json    the SIGNED list (IDs only)       — this is what gets published
 *
 * If your private key is somewhere else, set GNHS_PRIVATE_KEY to its path.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const LIST = path.join(__dirname, "machines.json");
const OUT = path.join(__dirname, "..", "server", "allowlist.json");
const CHECKER = path.join(__dirname, "..", "server", "license-check.js");
const KEY = process.env.GNHS_PRIVATE_KEY || path.join(__dirname, "private-key.pem");
const PREFIX = "GNHS-ALLOWLIST-v1|";   // must match server/license-check.js (old apps still verify this)
const PREFIX2 = "GNHS-ALLOWLIST-v2|";  // must match server/license-check.js (IDs + expiry dates)
const DEFAULT_DAYS = 365;
const KEY_PREFIX = "GNHS-LICENSE-v2|"; // must match SIGN_PREFIX in server/license-check.js (old license.key files use it too)
const KEYS_OUT = path.join(__dirname, "license-keys.txt");
const ID_RE = /^[0-9a-f]{24}$/;

const fail = (msg) => { console.error("✖ " + msg); process.exit(1); };
const load = () => (fs.existsSync(LIST) ? JSON.parse(fs.readFileSync(LIST, "utf8")) : []);

/** The public key currently written inside license-check.js (what the apps will use). */
function appPublicKey() {
  const src = fs.readFileSync(CHECKER, "utf8");
  const m = src.match(/-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/);
  if (!m) fail("Could not find the PUBLIC_KEY block in server/license-check.js");
  return crypto.createPublicKey(m[0]);
}

/** Reads --expires / --days / --never from the arguments. Returns { expiresAt, rest }. */
function parseExpiry(args, useDefault) {
  const rest = [];
  let expiresAt = useDefault ? endOfDayPH(new Date(Date.now() + DEFAULT_DAYS * 86400000).toISOString().slice(0, 10)) : undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--never") expiresAt = null;
    else if (a === "--expires") {
      const d = args[++i];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d || "") || isNaN(Date.parse(d))) fail("--expires needs a date like 2027-06-30");
      expiresAt = endOfDayPH(d);
    } else if (a === "--days") {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) fail("--days needs a whole number, e.g. --days 365");
      expiresAt = endOfDayPH(new Date(Date.now() + n * 86400000).toISOString().slice(0, 10));
    } else rest.push(a);
  }
  return { expiresAt, rest };
}

/** "2027-06-30" -> end of that day in Philippine time (UTC+8), as an ISO string. */
function endOfDayPH(ymd) { return new Date(ymd + "T23:59:59+08:00").toISOString(); }

const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString("en-PH", { timeZone: "Asia/Manila", day: "numeric", month: "short", year: "numeric" }) : "never");

/** The LICENSE KEY for one machine ID: GNHS-XXXXX-XXXXX-… (the same key every time you ask). */
function sigFor(id) {
  if (!fs.existsSync(KEY)) fail(`Private key not found at ${KEY}.`);
  const sig = crypto.sign(null, Buffer.from(KEY_PREFIX + id), crypto.createPrivateKey(fs.readFileSync(KEY)));
  if (!crypto.verify(null, Buffer.from(KEY_PREFIX + id), appPublicKey(), sig)) {
    fail("This private key does NOT match the PUBLIC_KEY in server/license-check.js.");
  }
  return sig;
}

/** The app's code key (admin/app-key.txt), or null if sealing isn't set up. */
function loadAppKey() {
  const f = process.env.GNHS_APP_KEY_FILE || path.join(__dirname, "app-key.txt");
  const hex = process.env.GNHS_APP_KEY || (fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim() : "");
  return /^[0-9a-f]{64}$/i.test(hex) ? Buffer.from(hex, "hex") : null;
}

/** Locks the app's code key so ONLY this machine ID + its license key can open it (must match license-check.js). */
function wrapAppKey(appKey, id) {
  const wrapKey = crypto.createHash("sha256").update("GNHS-WRAP-v1|" + id + "|").update(sigFor(id)).digest();
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", wrapKey, iv);
  const ct = Buffer.concat([c.update(appKey), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), ct]).toString("base64");
}

function makeKey(id) {
  const sig = sigFor(id);
  const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0, out = "";
  for (const b of sig) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return "GNHS-" + out.match(/.{1,5}/g).join("-");
}

function publish(machines) {
  if (!fs.existsSync(KEY)) fail(`Private key not found at ${KEY}. Run "node admin/manage-allowlist.js init" once to create it.`);

  const issuedAt = new Date().toISOString();
  const key = crypto.createPrivateKey(fs.readFileSync(KEY));
  const sorted = [...machines].sort((a, b) => (a.id < b.id ? -1 : 1));
  // If the app is sealed (admin/app-key.txt exists), every machine also gets "wk": the app's code key,
  // locked with that machine's ID + license key. Not part of the signature — tampering just breaks it.
  const appKey = loadAppKey();
  const outMachines = sorted.map((m) => {
    const e = { id: m.id };
    if (m.expiresAt) e.expiresAt = m.expiresAt;
    if (appKey) e.wk = wrapAppKey(appKey, m.id);
    return e;
  });
  if (!appKey) console.log("  (note: no admin/app-key.txt — the app is not sealed; run \"node admin/seal.js init\" to turn that on)");

  // sig  = IDs only (so apps installed before expiry existed keep working)
  // sig2 = IDs + expiry dates (what current apps check, so a date can't be edited)
  const payload1 = Buffer.from(PREFIX + issuedAt + "|" + sorted.map((m) => m.id).join(","));
  const payload2 = Buffer.from(PREFIX2 + issuedAt + "|" + sorted.map((m) => m.id + "@" + (m.expiresAt || "never")).join(","));
  const sig = crypto.sign(null, payload1, key);
  const sig2 = crypto.sign(null, payload2, key);

  // Safety check: the apps must be able to verify what we just signed.
  const pub = appPublicKey();
  if (!crypto.verify(null, payload1, pub, sig) || !crypto.verify(null, payload2, pub, sig2)) {
    fail("This private key does NOT match the PUBLIC_KEY in server/license-check.js. Nothing was written.");
  }

  fs.writeFileSync(LIST, JSON.stringify(machines, null, 2));
  fs.writeFileSync(
    OUT,
    JSON.stringify({ issuedAt, machines: outMachines, sig: sig.toString("base64"), sig2: sig2.toString("base64") }, null, 2)
  );
  console.log(`✔ server/allowlist.json signed — ${sorted.length} machine(s) allowed.`);
  console.log("  Next: git add server/allowlist.json && git commit -m \"Update allowlist\" && git push");
}

const [cmd, arg, ...restRaw] = process.argv.slice(2);
const machines = load();
const NOW_ISO = () => new Date().toISOString();

if (cmd === "init") {
  // One-time setup: make your signing key pair.
  if (fs.existsSync(KEY) && arg !== "--force") {
    fail(`${KEY} already exists. Refusing to overwrite it (that would invalidate every list you signed). Use "init --force" only if you really want a new key.`);
  }
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  fs.writeFileSync(KEY, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  const pub = publicKey.export({ type: "spki", format: "pem" }).toString().trim();

  // Put the new PUBLIC key into server/license-check.js (the part that ships in the app).
  const src = fs.readFileSync(CHECKER, "utf8");
  const re = /-----BEGIN PUBLIC KEY-----[\s\S]*?-----END PUBLIC KEY-----/;
  if (!re.test(src)) fail("Could not find the PUBLIC_KEY block in server/license-check.js");
  fs.writeFileSync(CHECKER, src.replace(re, () => pub));

  console.log("✔ New key pair created.");
  console.log(`  Private key saved to: ${KEY}   <-- BACK THIS UP. Never commit it or share it.`);
  console.log("  Public key written into server/license-check.js.");
  console.log("  Next: node admin/manage-allowlist.js import teachers.txt");

} else if (cmd === "add") {
  const id = String(arg || "").trim().toLowerCase();
  if (!ID_RE.test(id)) fail("Machine ID must be the 24-character ID shown by the app.");
  const { expiresAt: exp, rest } = parseExpiry(restRaw, true);
  const given = restRaw.some((a) => ["--never", "--expires", "--days"].includes(a));
  const label = rest.join(" ") || "Unnamed";
  const existing = machines.find((m) => m.id === id);
  if (existing) { existing.label = label; if (given) existing.expiresAt = exp || undefined; }
  else machines.push({ id, label, addedAt: NOW_ISO(), ...(exp ? { expiresAt: exp } : {}) });
  console.log(`  ${label}: valid until ${fmt(exp && (existing && !given ? existing.expiresAt : exp))}`);
  publish(machines);

} else if (cmd === "import") {
  if (!arg || !fs.existsSync(arg)) fail("Give the path to a text file: node admin/manage-allowlist.js import teachers.txt");
  const { expiresAt: exp } = parseExpiry(restRaw, true);
  let added = 0, updated = 0;
  for (const raw of fs.readFileSync(arg, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [idRaw, ...nameParts] = line.split(/\s+/);
    const id = idRaw.toLowerCase();
    if (!ID_RE.test(id)) { console.error("  skipped (bad ID): " + line); continue; }
    const label = nameParts.join(" ");
    const existing = machines.find((m) => m.id === id);
    if (existing) { if (label) existing.label = label; updated++; }
    else { machines.push({ id, label: label || "Unnamed", addedAt: NOW_ISO(), ...(exp ? { expiresAt: exp } : {}) }); added++; }
  }
  console.log(`  ${added} added (valid until ${fmt(exp)}), ${updated} already on the list.`);
  publish(machines);

} else if (cmd === "remove") {
  const q = String(arg || "").trim().toLowerCase();
  const hits = machines.filter((m) => m.id === q || (q.length >= 6 && m.id.startsWith(q)));
  if (hits.length === 0) fail("No such machine ID on the list.");
  if (hits.length > 1) fail("More than one match — type more of the ID.");
  console.log(`  Removing: ${hits[0].label} (${hits[0].id})`);
  publish(machines.filter((m) => m !== hits[0]));

} else if (cmd === "renew") {
  const { expiresAt: exp } = parseExpiry(restRaw, true);
  const q = String(arg || "").trim().toLowerCase();
  if (!q) fail('Say who to renew: renew <machineId> or renew all');
  const hits = q === "all" ? machines : machines.filter((m) => m.id === q || (q.length >= 6 && m.id.startsWith(q)));
  if (hits.length === 0) fail("No such machine ID on the list.");
  if (q !== "all" && hits.length > 1) fail("More than one match — type more of the ID.");
  hits.forEach((m) => { m.expiresAt = exp || undefined; console.log(`  ${m.label}: valid until ${fmt(exp)}`); });
  publish(machines);

} else if (cmd === "publish") {
  publish(machines);

} else if (cmd === "key") {
  const q = String(arg || "").trim().toLowerCase();
  if (!q) fail("Say whose key: key <machineId> or key all");
  const hits = q === "all" ? machines : machines.filter((m) => m.id === q || (q.length >= 6 && m.id.startsWith(q)));
  if (hits.length === 0) fail("No such machine ID on the list. Add it first.");
  if (q !== "all" && hits.length > 1) fail("More than one match — type more of the ID.");
  const lines = hits.map((m) => ({ m, k: makeKey(m.id) }));
  if (q === "all") {
    fs.writeFileSync(KEYS_OUT, "GNHS Quiz — license keys (keep private; send each teacher ONLY their own key)\n\n" +
      lines.map(({ m, k }) => `${m.label}\nMachine ID: ${m.id}\nLicense key: ${k}\n`).join("\n"), { mode: 0o600 });
    console.log(`✔ ${lines.length} key(s) saved to ${KEYS_OUT}`);
  } else {
    console.log(`\n${lines[0].m.label}  (${lines[0].m.id})\nLICENSE KEY:\n\n${lines[0].k}\n`);
  }

} else if (cmd === "list") {
  const now = Date.now();
  machines.forEach((m, i) => {
    const left = m.expiresAt ? Math.ceil((Date.parse(m.expiresAt) - now) / 86400000) : null;
    const note = left === null ? "no expiry" : left <= 0 ? "EXPIRED" : left <= 30 ? `expires ${fmt(m.expiresAt)} (${left} days left!)` : `expires ${fmt(m.expiresAt)}`;
    console.log(`${String(i + 1).padStart(2)}. ${m.id}  ${m.label}  — ${note}`);
  });
  console.log(`${machines.length} allowed.`);

} else {
  console.log('Commands:\n  init   (one time)\n  add <id> "name" [--expires YYYY-MM-DD | --days N | --never]\n  import <file> [--expires ... | --days N | --never]\n  renew <id|all> [--expires YYYY-MM-DD | --days N | --never]\n  key <id|all>   (prints the license key)\n  publish        (re-sign the list; do this after sealing)\n  remove <id>\n  list');
}
