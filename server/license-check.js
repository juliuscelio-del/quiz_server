/**
 * ═══════════════════════════════════════════════════════════════
 *   LICENSE LOCK — GNHS Quiz System
 *   Copyright (c) Julius Celio. All Rights Reserved.
 *
 *   This file locks the quiz server to specific, pre-authorized
 *   machines. Do not remove or modify — doing so is what this
 *   protection is meant to prevent.
 * ═══════════════════════════════════════════════════════════════
 */

const os = require("os");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execSync } = require("child_process");
const DATA_DIR = process.env.GNHS_DATA_DIR || __dirname;

// Secret split across parts so it isn't a single greppable string.
// This raises the bar against casual copying — it is NOT unbreakable
// against someone determined to read and patch this file.
const _p = ["Gu4d", "4lup3", "-QU1Z", "-J.C3l10", "-2026", "!lock"];
const SECRET = _p.join("");

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

function sign(machineId) {
  return crypto.createHmac("sha256", SECRET).update(machineId).digest("hex");
}

const LICENSE_FILE = path.resolve(DATA_DIR, "license.key");

function checkLicense() {
  const machineId = getMachineId();

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

  const { machineId: licensedId, signature, label } = data;

  if (!licensedId || !signature) {
    printLockedMessage(machineId, "license.key is missing required fields.");
    process.exit(1);
  }

  if (licensedId !== machineId) {
    printLockedMessage(machineId, "This license.key was issued for a different machine.");
    process.exit(1);
  }

  const expected = sign(licensedId);
  if (expected !== signature) {
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
  console.error("  Send this ID to Julius Celio to request a license.key");
  console.error("  for this device. The server will not start without it.");
  console.error("═══════════════════════════════════════════════════════\n");
}

module.exports = { checkLicense, getMachineId };
