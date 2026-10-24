/**
 * GNHS Quiz — Teacher app
 *
 * Runs the quiz server inside the app and shows the teacher dashboard.
 * ALL saved data lives in one folder that belongs to this app (see DATA_DIR),
 * not inside the program files, so updating or reinstalling the app never
 * erases results, the roster, the item bank or pictures.
 */
const { app, BrowserWindow, Menu, dialog, shell, clipboard, ipcMain } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const PORT = 3000;

// ── One copy at a time (two servers would fight over port 3000) ─────────────
if (!app.requestSingleInstanceLock()) {
  app.quit();
  return;
}

// ── Where the data lives ─────────────────────────────────────────────────────
//   Mac:     ~/Library/Application Support/GNHS Quiz Teacher/data
//   Windows: %APPDATA%\GNHS Quiz Teacher\data
const APP_HOME = app.getPath("userData");
const DATA_DIR = path.join(APP_HOME, "data");
const AUTO_BACKUP_DIR = path.join(APP_HOME, "auto-backups");
const PENDING_IMPORT = path.join(APP_HOME, "pending-import.txt");
fs.mkdirSync(DATA_DIR, { recursive: true });
process.env.GNHS_DATA_DIR = DATA_DIR;
process.env.PORT = String(PORT);

const DATA_FILES = [
  "quiz-data", "students", "points", "in-progress-sessions", "quiz-archive",
  "quiz-archive.backup", "question-history", "item-bank", "active-quiz",
  "quiz-duration", "exam-type", "student-questions", "enabled-sections",
  "disabled-sections", "exams",
].map((n) => n + ".json");

// ── Helpers ──────────────────────────────────────────────────────────────────
function lanIps() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets))
    for (const n of nets[name] || [])
      if (n.family === "IPv4" && !n.internal) out.push(n.address);
  return out;
}

function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function copyDataInto(destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(DATA_DIR, destDir, { recursive: true });
}

// Copies the known data files, pictures and license from an old SERVER folder.
function importFrom(srcDir) {
  let count = 0;
  for (const f of [...DATA_FILES, "license.key"]) {
    const from = path.join(srcDir, f);
    if (fs.existsSync(from)) { fs.copyFileSync(from, path.join(DATA_DIR, f)); count++; }
  }
  const pics = path.join(srcDir, "item-images");
  if (fs.existsSync(pics)) {
    fs.cpSync(pics, path.join(DATA_DIR, "item-images"), { recursive: true });
    count++;
  }
  return count;
}

function chooseOldFolder(title) {
  const r = dialog.showOpenDialogSync({
    title, buttonLabel: "Use this folder", properties: ["openDirectory"],
  });
  return r && r[0];
}

// ── Import must happen BEFORE the server starts, or the running server would
//    overwrite the imported files with what it has in memory. ──────────────────
function runStartupImport() {
  // 1) an import requested from the menu last time
  if (fs.existsSync(PENDING_IMPORT)) {
    const src = fs.readFileSync(PENDING_IMPORT, "utf8").trim();
    fs.unlinkSync(PENDING_IMPORT);
    if (src && fs.existsSync(src)) {
      const n = importFrom(src);
      dialog.showMessageBoxSync({ type: "info", message: `Imported ${n} item(s) from your old SERVER folder.` });
    }
    return;
  }
  // 2) very first run: offer to bring the old data in
  const fresh = !fs.existsSync(path.join(DATA_DIR, "students.json")) &&
                !fs.existsSync(path.join(DATA_DIR, "license.key"));
  if (!fresh) return;
  const pick = dialog.showMessageBoxSync({
    type: "question", title: "GNHS Quiz Teacher", buttons: ["Choose old SERVER folder…", "Start fresh"],
    defaultId: 0, cancelId: 1,
    message: "Welcome! Do you have an existing SERVER folder with your students, results and license.key?",
    detail: "Choose it and everything will be copied into this app. Your original folder is not changed.",
  });
  if (pick === 0) {
    const src = chooseOldFolder("Choose your old SERVER folder");
    if (src) {
      const n = importFrom(src);
      dialog.showMessageBoxSync({ type: "info", message: n ? `Imported ${n} item(s). You're all set.` : "No quiz data files were found in that folder." });
    }
  }
}

// ── Start the quiz server inside this process ────────────────────────────────
class ExitSignal extends Error {}

function startServer() {
  const realExit = process.exit;
  process.exit = (code) => { throw new ExitSignal(String(code)); }; // license check calls process.exit(1)
  try {
    require("../server/server.js");
    return true;
  } catch (e) {
    if (e instanceof ExitSignal) return false;
    throw e;
  } finally {
    process.exit = realExit;
  }
}

function showLicenseProblem() {
  const id = require("../server/license-check.js").getMachineId();
  for (;;) {
    const pick = dialog.showMessageBoxSync({
      type: "warning", title: "License needed", defaultId: 0, cancelId: 3,
      buttons: ["Copy machine ID", "Open data folder", "Import old SERVER folder…", "Quit"],
      message: "This computer doesn't have a valid license.key yet.",
      detail:
        `Machine ID:\n${id}\n\n` +
        "Option 1: send this ID to Julius Celio to get a license.key, then put it in the data folder and reopen the app.\n" +
        "Option 2: if this computer already ran the quiz server, import your old SERVER folder (its license.key comes along).",
    });
    if (pick === 0) clipboard.writeText(id);
    else if (pick === 1) shell.openPath(DATA_DIR);
    else if (pick === 2) {
      const src = chooseOldFolder("Choose your old SERVER folder");
      if (src) { importFrom(src); app.relaunch(); app.exit(0); return; }
    } else { app.exit(0); return; }
  }
}

function waitForServer(ms = 20000) {
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      http.get({ host: "127.0.0.1", port: PORT, path: "/health", timeout: 1000 }, (res) => {
        res.resume(); resolve(res.statusCode === 200);
      }).on("error", () => {
        if (Date.now() - t0 > ms) resolve(false); else setTimeout(tick, 300);
      }).on("timeout", function () { this.destroy(); });
    };
    tick();
  });
}

// ── Window + menu ────────────────────────────────────────────────────────────
let win = null;
let quitting = false;

function showStudentLink() {
  const ips = lanIps();
  const lines = ips.length
    ? ips.map((ip) => `http://${ip}:${PORT}`).join("\n")
    : "No network found. Connect to Wi-Fi first.";
  dialog.showMessageBox(win, {
    type: "info", title: "Student link", buttons: ["OK", "Copy"],
    message: "Students using the GNHS Quiz app are found automatically.",
    detail: `Or they can open this link in a browser:\n\n${lines}`,
  }).then((r) => { if (r.response === 1 && ips[0]) clipboard.writeText(`http://${ips[0]}:${PORT}`); });
}

function backupNow() {
  const dest = path.join(app.getPath("documents"), "GNHS Quiz Backups", stamp());
  try {
    copyDataInto(dest);
    dialog.showMessageBox(win, { type: "info", buttons: ["OK", "Show folder"], message: "Backup saved.", detail: dest })
      .then((r) => { if (r.response === 1) shell.showItemInFolder(dest); });
  } catch (e) {
    dialog.showErrorBox("Backup failed", String(e.message || e));
  }
}

// ── Save Now: flush the server's data to disk, then keep a dated copy ───────
function flushServer() {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: "127.0.0.1", port: PORT, path: "/api/save-now", method: "POST", timeout: 8000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => {
          try { const j = JSON.parse(body); j.ok ? resolve(j) : reject(new Error((j.failed || []).join(", ") || j.message || "Save failed")); }
          catch (e) { reject(new Error("Unexpected reply from the quiz server")); }
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("The quiz server did not answer")));
    req.end();
  });
}

const SAVES_DIR = () => path.join(app.getPath("documents"), "GNHS Quiz Backups", "Saved");

async function saveNow() {
  await flushServer();                       // 1) everything in memory -> data folder
  const dest = path.join(SAVES_DIR(), stamp());
  copyDataInto(dest);                        // 2) dated copy in Documents
  // keep the 30 newest manual saves so the folder doesn't grow forever
  const all = fs.readdirSync(SAVES_DIR()).sort();
  for (const old of all.slice(0, Math.max(0, all.length - 30)))
    fs.rmSync(path.join(SAVES_DIR(), old), { recursive: true, force: true });
  return dest;
}

ipcMain.handle("gnhs:save-now", async () => {
  try { return { ok: true, folder: await saveNow() }; }
  catch (e) { return { ok: false, error: String(e.message || e) }; }
});

function importFromMenu() {
  const src = chooseOldFolder("Choose your old SERVER folder");
  if (!src) return;
  const ok = dialog.showMessageBoxSync(win, {
    type: "warning", buttons: ["Import and restart", "Cancel"], defaultId: 1, cancelId: 1,
    message: "Replace the data in this app with the data from that folder?",
    detail: "Current data in the app will be overwritten. Tip: use File → Back Up Data first.",
  });
  if (ok !== 0) return;
  fs.writeFileSync(PENDING_IMPORT, src);
  app.relaunch();
  app.quit();
}

function buildMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "Save Now", accelerator: "CmdOrCtrl+S", click: () => win && win.webContents.send("gnhs:save-requested") },
        { label: "Show Student Link", click: showStudentLink },
        { type: "separator" },
        { label: "Open Data Folder", click: () => shell.openPath(DATA_DIR) },
        { label: "Back Up Data…", click: backupNow },
        { label: "Import From Old SERVER Folder…", click: importFromMenu },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "viewMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, title: "GNHS Quiz Teacher",
    webPreferences: { contextIsolation: true, nodeIntegration: false, preload: path.join(__dirname, "preload.js") },
  });
  win.maximize();
  win.loadURL(`http://localhost:${PORT}/dashboard`);
  win.webContents.on("did-fail-load", (_e, code, _d, _u, isMain) => {
    if (isMain && code !== -3) setTimeout(() => win && win.loadURL(`http://localhost:${PORT}/dashboard`), 1000);
  });
  // Closing the window stops the quiz for every student, so ask first.
  win.on("close", (e) => {
    if (quitting) return;
    const r = dialog.showMessageBoxSync(win, {
      type: "warning", buttons: ["Keep running", "Stop server and quit"], defaultId: 0, cancelId: 0,
      message: "Quit the teacher app?",
      detail: "This stops the quiz server. Students will be disconnected.",
    });
    if (r === 0) e.preventDefault();
  });
}

// On quit: let the server flush everything, then keep a safety copy.
app.on("before-quit", () => {
  if (quitting) return;
  quitting = true;
  const realExit = process.exit;
  process.exit = () => {
    try {
      copyDataInto(path.join(AUTO_BACKUP_DIR, stamp()));
      const all = fs.readdirSync(AUTO_BACKUP_DIR).sort();
      for (const old of all.slice(0, Math.max(0, all.length - 10)))
        fs.rmSync(path.join(AUTO_BACKUP_DIR, old), { recursive: true, force: true });
    } catch (_) {}
    realExit(0);
  };
  process.emit("SIGINT"); // server.js saves all data, then calls process.exit
  process.exit = realExit; // (only reached if the server never started)
});

process.on("uncaughtException", (err) => {
  if (err && err.code === "EADDRINUSE") {
    dialog.showErrorBox("Port 3000 is busy",
      "Another quiz server (or program) is already using port 3000.\nClose it and open this app again.");
    app.exit(1);
  } else {
    console.error("Uncaught error:", err);
  }
});

app.whenReady().then(async () => {
  buildMenu();
  runStartupImport();
  if (!startServer()) return showLicenseProblem();
  const up = await waitForServer();
  if (!up) {
    dialog.showErrorBox("Server didn't start", "The quiz server did not respond. Close the app and try again.");
    return app.exit(1);
  }
  createWindow();
});

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on("window-all-closed", () => app.quit());
