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
 *   The old per-machine license.key still works, but ONLY until
 *   the first signed allowlist exists. After that the allowlist
 *   is the single authority.
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

/** Reads a list file and returns it ONLY if its signature is valid, else null. */
function readAllowlist(file) {
  try {
    const list = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!list || !Array.isArray(list.machines) || !list.issuedAt || !list.sig) return null;
    if (!list.machines.every((m) => m && typeof m.id === "string")) return null;
    const ids = list.machines.map((m) => m.id).sort();
    const payload = ALLOWLIST_PREFIX + list.issuedAt + "|" + ids.join(",");
    const ok = crypto.verify(
      null,
      Buffer.from(payload),
      crypto.createPublicKey(PUBLIC_KEY),
      Buffer.from(String(list.sig), "base64")
    );
    return ok ? list : null;
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

/** False only when a valid allowlist exists and this machine is NOT on it. */
function isStillAllowed() {
  const list = bestAllowlist();
  return !list || list.machines.some((m) => m.id === getMachineId());
}

// ── Old per-machine license.key check ────────────────────────────────────────

/** Returns true / false, or throws if the public key above was never filled in. */
function signatureIsValid(machineId, sig2) {
  const publicKey = crypto.createPublicKey(PUBLIC_KEY); // throws if still the placeholder
  return crypto.verify(
    null,
    Buffer.from(SIGN_PREFIX + machineId),
    publicKey,
    Buffer.from(String(sig2), "base64")
  );
}

function checkLicense() {
  const machineId = getMachineId();

  // 1) Allowlist: once a valid signed list exists, it is the ONLY authority.
  const allowlist = bestAllowlist();
  if (allowlist) {
    const entry = allowlist.machines.find((m) => m.id === machineId);
    if (entry) {
      console.log(`✔ License OK (machine ${machineId.slice(0, 8)}…)`);
      return;
    }
    printLockedMessage(machineId, "This machine is not on the approved list.");
    process.exit(1);
  }

  // 2) No allowlist anywhere yet: fall back to the old license.key.
  if (!fs.existsSync(LICENSE_FILE)) {
    printLockedMessage(machineId, "No license.key file found.");
    process.exit(1);
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(LICENSE_FILE, "utf8"));
  } catch (e) {
    printLockedMessage(machineId, "license.key is unreadable or corrupted.");
    process.exit(1);
  }

  const { machineId: licensedId, sig2, label } = data;

  if (!licensedId || !sig2) {
    printLockedMessage(machineId, "license.key is missing required fields (ask for a new license.key).");
    process.exit(1);
  }

  if (licensedId !== machineId) {
    printLockedMessage(machineId, "This license.key was issued for a different machine.");
    process.exit(1);
  }

  let ok = false;
  try {
    ok = signatureIsValid(licensedId, sig2);
  } catch (e) {
    printLockedMessage(machineId, "This app build has no valid public key set up.");
    process.exit(1);
  }
  if (!ok) {
    printLockedMessage(machineId, "license.key signature is invalid.");
    process.exit(1);
  }

  console.log(`✔ License OK${label ? ` — ${label}` : ""} (machine ${machineId.slice(0, 8)}…)`);
}

function printLockedMessage(machineId, reason) {
  console.error("\n═══════════════════════════════════════════════════════");
  console.error("  🔒  GNHS QUIZ SYSTEM — UNLICENSED MACHINE");
  console.error("═══════════════════════════════════════════════════════");
  console.error(`  Reason: ${reason}`);
  console.error(`  This machine's ID: ${machineId}`);
  console.error("");
  console.error("  Send this ID to Julius Celio to get this device approved.");
  console.error("  The server will not start without it.");
  console.error("═══════════════════════════════════════════════════════\n");
}

module.exports = { checkLicense, getMachineId, refreshAllowlist, isStillAllowed };
