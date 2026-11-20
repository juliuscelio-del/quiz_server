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
const { startAutoCheck } = require("./updater");

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
  "disabled-sections", "exams", "school", "admin",
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
    require("../server/secure-loader.js").loadServer();
    return true;
  } catch (e) {
    if (e instanceof ExitSignal) return false;
    throw e;
  } finally {
    process.exit = realExit;
  }
}

// ── License ──────────────────────────────────────────────────────────────────
// Runs the license check WITHOUT starting the server. true = this computer is approved.
function licenseOk() {
  const lic = require("../server/license-check.js");
  const realExit = process.exit;
  process.exit = () => { throw new ExitSignal("license"); };
  try {
    lic.checkLicense();
    return true;
  } catch (e) {
    if (e instanceof ExitSignal) return false;
    throw e;
  } finally {
    process.exit = realExit;
  }
}

// Shown when this computer is not approved: ONE message, ONE OK button, then the app closes.
function notAllowedHtml(id, expiredOn) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Not allowed</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;overflow:hidden}
  body{
    font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;
    background:radial-gradient(circle at 50% 0%,#7f1d1d 0%,#3b0a0a 45%,#1a0505 100%);
    color:#fff;display:flex;align-items:center;justify-content:center;
    -webkit-app-region:drag;user-select:none;
  }
  .card{
    width:100%;height:100%;padding:34px 36px 28px;text-align:center;
    border:2px solid #ef4444;border-radius:0;
    box-shadow:inset 0 0 60px rgba(239,68,68,.25);
    display:flex;flex-direction:column;align-items:center;
    animation:shake .5s ease-out;
  }
  .icon{
    width:96px;height:96px;border-radius:50%;
    background:linear-gradient(145deg,#fbbf24,#f59e0b);
    display:flex;align-items:center;justify-content:center;
    box-shadow:0 0 0 0 rgba(251,191,36,.6);
    animation:pulse 1.8s infinite;
  }
  .icon svg{width:56px;height:56px}
  .badge{
    margin-top:18px;padding:5px 16px;border-radius:999px;
    background:#ef4444;font-weight:800;font-size:13px;letter-spacing:.22em;
  }
  h1{margin-top:16px;font-size:25px;line-height:1.3;font-weight:800;text-shadow:0 2px 12px rgba(0,0,0,.5)}
  h1 b{color:#fbbf24}
  .idbox{
    margin-top:22px;width:100%;padding:12px 14px;border-radius:12px;
    background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.18);
  }
  .idbox small{display:block;font-size:11px;letter-spacing:.18em;text-transform:uppercase;color:#fca5a5;margin-bottom:4px}
  .idbox code{font-family:Consolas,"SF Mono",Menlo,monospace;font-size:17px;letter-spacing:.06em;color:#fde68a;user-select:text;-webkit-user-select:text}
  .idrow{display:flex;align-items:center;justify-content:center;gap:12px}
  .idrow .copy{
    -webkit-app-region:no-drag;margin:0;width:auto;padding:8px 16px;border-radius:8px;
    font-size:13px;letter-spacing:.08em;white-space:nowrap;
    background:linear-gradient(180deg,#fbbf24,#d97706);color:#3b0a0a;box-shadow:0 3px 10px rgba(251,191,36,.35);
  }
  .idrow .copy.done{background:linear-gradient(180deg,#4ade80,#16a34a);color:#052e16}
  button{
    -webkit-app-region:no-drag;margin-top:auto;width:100%;padding:14px;
    border:0;border-radius:12px;cursor:pointer;
    font-size:17px;font-weight:800;letter-spacing:.1em;color:#fff;
    background:linear-gradient(180deg,#ef4444,#b91c1c);
    box-shadow:0 6px 18px rgba(239,68,68,.45);
    transition:transform .1s,filter .15s;
  }
  button:hover{filter:brightness(1.12)}
  button:active{transform:scale(.98)}
  button:focus-visible{outline:3px solid #fde68a;outline-offset:2px}
  @keyframes pulse{70%{box-shadow:0 0 0 22px rgba(251,191,36,0)}100%{box-shadow:0 0 0 0 rgba(251,191,36,0)}}
  @keyframes shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-10px)}40%{transform:translateX(9px)}60%{transform:translateX(-6px)}80%{transform:translateX(4px)}}
  @media (prefers-reduced-motion:reduce){.card,.icon{animation:none}}
</style></head>
<body>
  <div class="card">
    <div class="icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="#7f1d1d" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4.5"/><circle cx="12" cy="17.3" r=".6" fill="#7f1d1d"/>
      </svg>
    </div>
    <div class="badge">${expiredOn ? "LICENSE EXPIRED" : "NOT ALLOWED"}</div>
    ${expiredOn
      ? `<h1>Natapos na ang <b>license</b> niini<br>kaniadtong <b>${expiredOn}</b></h1>
    <p style="margin-top:12px;font-size:14px;color:#fecaca">Send the Machine ID below to Julius Celio to renew.<br>Also check that this computer's date is correct.</p>`
      : `<h1><b>DI KA PWED</b> mogamit ane<br>ug wai pananghid sa tag.iya</h1>`}
    <div class="idbox">
      <small>Machine ID</small>
      <div class="idrow">
        <code>${id}</code>
        <button id="copy" class="copy" type="button">COPY</button>
      </div>
    </div>
    <button id="ok" autofocus>OK</button>
  </div>
  <script>
    const done = () => window.close();
    document.getElementById("ok").addEventListener("click", done);
    document.getElementById("copy").addEventListener("click", () => { location.href = "gnhs://copy"; });
    window.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === "Escape") done(); });
  </script>
</body></html>`;
}

// ── License key window ───────────────────────────────────────────────────────
// Shown ONCE when this computer is approved but has no (valid) license key yet.
// The teacher pastes the key Julius sent; it is saved, and the app starts.
function keyEntryHtml(id, badKey) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>License key</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{height:100%;overflow:hidden}
  body{font-family:"Segoe UI",system-ui,-apple-system,Roboto,Arial,sans-serif;color:#fff;
    background:radial-gradient(circle at 50% 0%,#1e3a8a 0%,#0f172a 60%,#020617 100%);-webkit-app-region:drag}
  .card{height:100%;padding:28px 32px 24px;display:flex;flex-direction:column;gap:12px;border:2px solid #3b82f6;
    box-shadow:inset 0 0 50px rgba(59,130,246,.2)}
  h1{font-size:22px;font-weight:800}
  p{font-size:13.5px;color:#bfdbfe;line-height:1.45}
  .id{padding:9px 12px;border-radius:10px;background:rgba(0,0,0,.4);border:1px solid rgba(255,255,255,.18);
    display:flex;align-items:center;justify-content:space-between;gap:10px}
  .id small{display:block;font-size:10px;letter-spacing:.16em;text-transform:uppercase;color:#93c5fd}
  .id code{font-family:Consolas,"SF Mono",Menlo,monospace;font-size:14px;color:#fde68a;user-select:text;-webkit-user-select:text}
  textarea{-webkit-app-region:no-drag;flex:1;min-height:90px;resize:none;padding:10px 12px;border-radius:10px;border:1px solid #475569;
    background:#0b1220;color:#fff;font-family:Consolas,"SF Mono",Menlo,monospace;font-size:13px;user-select:text;-webkit-user-select:text}
  textarea:focus{outline:2px solid #60a5fa}
  #err{min-height:18px;font-size:13px;color:#fca5a5;font-weight:600}
  .row{display:flex;gap:10px}
  button{-webkit-app-region:no-drag;cursor:pointer;border:0;border-radius:10px;padding:12px 18px;font-size:15px;font-weight:800;color:#fff}
  #go{flex:1;background:linear-gradient(180deg,#3b82f6,#1d4ed8)}
  #quit{background:#334155}
  #copy{padding:7px 12px;font-size:12px;background:linear-gradient(180deg,#fbbf24,#d97706);color:#3b0a0a;white-space:nowrap}
  button:hover{filter:brightness(1.12)}
</style></head>
<body><div class="card">
  <h1>🔑 Enter your license key</h1>
  <p>This computer is approved. Paste the <b>license key</b> that Julius Celio sent you. You only do this once.</p>
  <div class="id"><div><small>Your Machine ID</small><code>${id}</code></div><button id="copy" type="button">COPY</button></div>
  <textarea id="key" placeholder="GNHS-XXXXX-XXXXX-XXXXX-…" spellcheck="false" autofocus></textarea>
  <div id="err">${badKey ? "The saved license key is not valid for this computer. Paste a new one." : ""}</div>
  <div class="row"><button id="quit" type="button">Quit</button><button id="go" type="button">ACTIVATE</button></div>
</div>
<script>
  const go = () => { const v = document.getElementById("key").value.trim(); if (!v) return; location.href = "gnhs://activate?key=" + encodeURIComponent(v); };
  document.getElementById("go").addEventListener("click", go);
  document.getElementById("quit").addEventListener("click", () => { location.href = "gnhs://quit"; });
  document.getElementById("copy").addEventListener("click", () => { location.href = "gnhs://copy"; });
  document.getElementById("key").addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); go(); } });
</script></body></html>`;
}

// Resolves true when a valid key was saved, false if the teacher quit.
function askForLicenseKey(badKey) {
  const lic = require("../server/license-check.js");
  const id = lic.getMachineId();
  return new Promise((resolve) => {
    const w = new BrowserWindow({
      width: 560, height: 430, frame: false, resizable: false, minimizable: false, maximizable: false,
      alwaysOnTop: true, center: true, show: false, backgroundColor: "#0f172a", title: "License key",
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    let result = false;
    const showError = (msg) => w.webContents.executeJavaScript(
      `document.getElementById("err").textContent=${JSON.stringify(msg)};`).catch(() => {});
    w.webContents.on("will-navigate", (e, url) => {
      if (!url.startsWith("gnhs://")) return;
      e.preventDefault();
      if (url.startsWith("gnhs://copy")) {
        clipboard.writeText(id);
      } else if (url.startsWith("gnhs://activate")) {
        const key = decodeURIComponent((url.split("key=")[1] || ""));
        const r = lic.installKey(key);
        if (r.ok) { result = true; w.close(); } else showError(r.reason);
      } else if (url.startsWith("gnhs://quit")) {
        w.close();
      }
    });
    w.once("ready-to-show", () => { w.show(); w.focus(); });
    w.on("closed", () => resolve(result));
    w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(keyEntryHtml(id, badKey)));
  });
}

function showNotAllowedAndQuit() {
  const lic = require("../server/license-check.js");
  const id = lic.getMachineId();
  const st = lic.getLicenseStatus();
  const expiredOn = st.state === "expired" ? lic.formatDate(st.expiresAt) : null;
  const w = new BrowserWindow({
    width: 500, height: 490,
    frame: false, resizable: false, minimizable: false, maximizable: false,
    alwaysOnTop: true, center: true, show: false,
    backgroundColor: "#3b0a0a", title: "Not allowed",
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  w.setMenu(null);
  // The COPY button asks the app (not the web page) to put the ID on the clipboard.
  w.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("gnhs://")) return;
    e.preventDefault();
    if (url.startsWith("gnhs://copy")) {
      clipboard.writeText(id);
      w.webContents.executeJavaScript(
        `(function(){var b=document.getElementById("copy");b.textContent="COPIED ✓";b.classList.add("done");` +
        `setTimeout(function(){b.textContent="COPY";b.classList.remove("done");},2000);})();`
      ).catch(() => {});
    }
  });
  w.once("ready-to-show", () => { w.show(); w.focus(); });
  w.on("closed", () => app.exit(0));   // OK, Enter, Esc or Alt+F4: the app closes, nothing else opens
  w.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(notAllowedHtml(id, expiredOn)));
}

// Friendly reminder (once per start) when this computer's license ends within 30 days.
function warnIfExpiringSoon() {
  try {
    const lic = require("../server/license-check.js");
    const st = lic.getLicenseStatus();
    if (st.state !== "expiring") return;
    dialog.showMessageBox(win || undefined, {
      type: "warning",
      title: "License ending soon",
      message: `Your GNHS Quiz license ends on ${lic.formatDate(st.expiresAt)} (${st.daysLeft} day${st.daysLeft === 1 ? "" : "s"} left).`,
      detail: `Send this Machine ID to Julius Celio to renew it:\n\n${st.machineId}\n\nRenewing needs no new app — just open the app while online.`,
      buttons: ["OK", "Copy Machine ID"],
      defaultId: 0,
    }).then((r) => { if (r.response === 1) clipboard.writeText(st.machineId); }).catch(() => {});
  } catch (e) { /* never block the app over a reminder */ }
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
let confirmedClose = false;   // the teacher has answered the exit dialog
let askingToClose = false;    // the exit dialog is currently open

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
  confirmedClose = true;   // skip the exit dialog; the app restarts right away
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
  win.on("close", async (e) => {
    if (quitting || confirmedClose) return;
    e.preventDefault();
    if (askingToClose) return;
    askingToClose = true;
    try {
      const r = await dialog.showMessageBox(win, {
        type: "question",
        title: "Exit GNHS Quiz Teacher",
        buttons: ["Save and exit", "Exit without saving", "Cancel"],
        defaultId: 0, cancelId: 2,
        message: "Save your work before exiting?",
        detail: "Exiting stops the quiz server. Students will be disconnected.",
      });
      if (r.response === 2) return;                 // Cancel: stay open

      if (r.response === 0) {                       // Save first
        try {
          await saveNow();
        } catch (err) {
          const f = await dialog.showMessageBox(win, {
            type: "error", buttons: ["Exit anyway", "Stay open"], defaultId: 1, cancelId: 1,
            message: "Could not save.", detail: String(err.message || err),
          });
          if (f.response === 1) return;
        }
      }
      confirmedClose = true;
      win.close();
    } finally {
      askingToClose = false;
    }
  });
}

// On quit: let the server flush everything, then keep a safety copy.
app.on("before-quit", (e) => {
  if (quitting) return;
  if (!confirmedClose && win && !win.isDestroyed()) {
    e.preventDefault();
    win.close();            // shows the Save / Exit / Cancel dialog
    return;
  }
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
  // 1) Check the license FIRST, before any other dialog or menu appears.
  let ok = licenseOk();
  if (!ok) {
    // Maybe Julius just approved this computer: download the newest list and try once more.
    await require("../server/license-check.js").refreshAllowlist();
    ok = licenseOk();
  }
  // Approved but no valid license key yet: ask for it (once), then carry on.
  if (!ok) {
    const state = require("../server/license-check.js").getLicenseStatus().state;
    if (state === "no-key" || state === "bad-key") {
      const entered = await askForLicenseKey(state === "bad-key");
      if (!entered) { app.exit(0); return; }
      ok = licenseOk();
    }
  }
  // Not approved / expired: show ONE popup with a single OK button, then close. Nothing else is reachable.
  if (!ok) { showNotAllowedAndQuit(); return; }

  // 2) Approved: normal startup.
  buildMenu();
  runStartupImport();
  if (!startServer()) { showNotAllowedAndQuit(); return; }

  const up = await waitForServer();
  if (!up) {
    dialog.showErrorBox("Server didn't start", "The quiz server did not respond. Close the app and try again.");
    return app.exit(1);
  }
  createWindow();
  warnIfExpiringSoon();
  // Checks for app updates AND keeps the approved-machines list fresh (hourly).
  startAutoCheck(win, async () => {
    try { await saveNow(); } catch (_) {}   // save the quiz data first
    confirmedClose = true;                  // skip the Save/Exit dialog
  });
});

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.on("window-all-closed", () => app.quit());
