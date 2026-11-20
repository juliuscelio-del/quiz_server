#!/usr/bin/env node
/**
 * Seal (encrypt) the quiz server code.   FOR JULIUS ONLY — never ship this folder inside the app.
 *
 *   node admin/seal.js init      ONE TIME: creates admin/app-key.txt (the app's code key). BACK IT UP.
 *   node admin/seal.js           encrypts server/server.js  ->  server/server.js.enc
 *   node admin/seal.js check     checks server.js.enc is up to date with server.js (no key needed)
 *
 * Run "seal" again every time you edit server/server.js, then re-publish the list
 * (node admin/manage-allowlist.js publish) and upload server/server.js.enc + server/allowlist.json.
 * The app that teachers install contains ONLY server.js.enc — never the readable server.js.
 *
 * Teachers can only unlock it with their license key + Machine ID (see server/secure-loader.js).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PLAIN = path.join(__dirname, "..", "server", "server.js");
const SEALED = path.join(__dirname, "..", "server", "server.js.enc");
const KEYFILE = process.env.GNHS_APP_KEY_FILE || path.join(__dirname, "app-key.txt");
const MAGIC = "GNHSENC1";

const fail = (m) => { console.error("✖ " + m); process.exit(1); };
const sha = (b) => crypto.createHash("sha256").update(b).digest();

function loadKey() {
  const hex = process.env.GNHS_APP_KEY || (fs.existsSync(KEYFILE) ? fs.readFileSync(KEYFILE, "utf8").trim() : "");
  if (!/^[0-9a-f]{64}$/i.test(hex)) fail(`No app key found. Run "node admin/seal.js init" once (it creates ${KEYFILE}).`);
  return Buffer.from(hex, "hex");
}

const cmd = process.argv[2];

if (cmd === "init") {
  if (fs.existsSync(KEYFILE) && process.argv[3] !== "--force") {
    fail(`${KEYFILE} already exists. Refusing to overwrite it (every sealed app and list depends on it). Use "init --force" only to rotate the key.`);
  }
  fs.writeFileSync(KEYFILE, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  console.log(`✔ App key created: ${KEYFILE}   <-- BACK THIS UP. Never upload it or share it.`);
  console.log("  Next: node admin/seal.js   then   node admin/manage-allowlist.js publish");

} else if (cmd === "check") {
  if (!fs.existsSync(SEALED)) fail("server/server.js.enc is missing. Run: node admin/seal.js");
  const enc = fs.readFileSync(SEALED);
  if (enc.slice(0, 8).toString() !== MAGIC) fail("server/server.js.enc is not a sealed file.");
  if (!enc.slice(8, 40).equals(sha(fs.readFileSync(PLAIN)))) {
    fail("server/server.js was changed after it was sealed. Run: node admin/seal.js   (then upload server.js.enc)");
  }
  console.log("✔ server.js.enc is up to date.");

} else if (!cmd || cmd === "seal") {
  if (!fs.existsSync(PLAIN)) fail("server/server.js not found.");
  const key = loadKey();
  const plain = fs.readFileSync(PLAIN);
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  fs.writeFileSync(SEALED, Buffer.concat([Buffer.from(MAGIC), sha(plain), iv, c.getAuthTag(), ct]));
  console.log(`✔ Sealed server/server.js -> server/server.js.enc (${ct.length} bytes).`);
  console.log("  Next: node admin/manage-allowlist.js publish   (gives each approved machine the unlock key)");
  console.log("  Then upload server/server.js.enc and server/allowlist.json to GitHub.");

} else {
  console.log("Commands:\n  init    (one time)\n  seal    (default)\n  check");
}
