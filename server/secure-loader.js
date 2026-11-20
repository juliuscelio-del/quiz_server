/**
 * SEALED APP LOADER — GNHS Quiz System
 * Copyright (c) Julius Celio. All Rights Reserved.
 *
 * The quiz server's code ships ENCRYPTED (server.js.enc). It can only be unlocked with a key that
 * is built from BOTH this computer's Machine ID and the license key Julius issued for it:
 *
 *   license key + Machine ID  ->  unlocks this machine's entry in the allowlist  ->  app code key
 *
 * Wrong machine, missing key, wrong key, expired approval, or a removed machine = the code cannot be
 * decrypted, so the app cannot open. (Patching out the checks does not help: there is nothing to run.)
 *
 * While developing (only server.js exists, no server.js.enc) it just loads server.js as before.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Module = require("module");

const PLAIN = path.join(__dirname, "server.js");
const SEALED = path.join(__dirname, "server.js.enc");
const MAGIC = "GNHSENC1"; // 8 bytes, then sha256(plain) 32, iv 12, tag 16, ciphertext

function decryptSealed(buf, key) {
  if (buf.slice(0, 8).toString() !== MAGIC) throw new Error("not a sealed file");
  const iv = buf.slice(40, 52), tag = buf.slice(52, 68), ct = buf.slice(68);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

function locked(reason) {
  console.error("\n═══════════════════════════════════════════════════════");
  console.error("  🔒  GNHS QUIZ SYSTEM — APP LOCKED");
  console.error("═══════════════════════════════════════════════════════");
  console.error("  " + reason);
  console.error("  The app can only open on a computer that is approved, not expired,");
  console.error("  and has its own license key. Contact Julius Celio.");
  console.error("═══════════════════════════════════════════════════════\n");
  process.exit(1);
}

function loadServer() {
  if (!fs.existsSync(SEALED)) return require("./server.js"); // development copy

  const lic = require("./license-check.js");
  const key = lic.getAppKey();
  if (!key) return locked("This computer cannot unlock the app (no valid license key for this Machine ID).");

  let code;
  try { code = decryptSealed(fs.readFileSync(SEALED), key); }
  catch (e) { return locked("The app code could not be unlocked (wrong key, or the file was changed)."); }

  // Run it exactly as if it were required from server/server.js, so relative requires keep working.
  const m = new Module(PLAIN, module);
  m.filename = PLAIN;
  m.paths = Module._nodeModulePaths(__dirname);
  require.cache[PLAIN] = m;
  m._compile(code, PLAIN);
  m.loaded = true;
  return m.exports;
}

module.exports = { loadServer };
