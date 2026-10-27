const { app, BrowserWindow, net, shell } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES = 'https://github.com/juliuscelio-del/quiz_server/releases/latest';
const isMac = process.platform === 'darwin';

autoUpdater.autoDownload = false;

let mainWin = null;
let beforeInstall = async () => {};
let popup = null;
let closeTimer = null;
let checking = false;
let finished = false;      // a check completed (found / not found)
let shownOffline = false;

// ── Small popup window ──────────────────────────────────────────────────────
function pageUrl({ title, message, spinner, progress, buttons = [] }) {
  const btns = buttons.map(b =>
    `<button class="${b.primary ? 'p' : ''}" onclick="location.href='gnhs://${b.action}'">${b.label}</button>`
  ).join('');
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;margin:0;padding:26px 22px;text-align:center;background:#fff;color:#222}
    h2{margin:10px 0 6px;font-size:17px}
    p{margin:0 0 18px;color:#555;font-size:14px}
    .spin{width:30px;height:30px;margin:0 auto;border:4px solid #ddd;border-top-color:#2e7d32;border-radius:50%;animation:s 1s linear infinite}
    @keyframes s{to{transform:rotate(360deg)}}
    .bar{height:8px;background:#eee;border-radius:4px;overflow:hidden;margin:0 0 18px}
    .bar div{height:100%;background:#2e7d32;width:${progress || 0}%}
    button{padding:8px 20px;margin:0 5px;border:1px solid #ccc;border-radius:6px;background:#f5f5f5;cursor:pointer;font-size:14px}
    button.p{background:#2e7d32;color:#fff;border-color:#2e7d32}
  </style></head><body>
    ${spinner ? '<div class="spin"></div>' : ''}
    <h2>${title}</h2><p>${message || ''}</p>
    ${progress != null ? '<div class="bar"><div id="fill"></div></div>' : ''}
    ${btns}
  </body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

function show(state, autoCloseMs) {
  clearTimeout(closeTimer);
  if (!popup || popup.isDestroyed()) {
    popup = new BrowserWindow({
      width: 380, height: 230, resizable: false, minimizable: false, maximizable: false,
      autoHideMenuBar: true, title: 'Update', center: true,
      parent: mainWin && !mainWin.isDestroyed() ? mainWin : undefined,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    popup.setMenuBarVisibility(false);
    popup.on('closed', () => { popup = null; });
    popup.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('gnhs://')) return;
      e.preventDefault();
      onAction(url.replace('gnhs://', '').replace(/\/$/, ''));
    });
  }
  popup.loadURL(pageUrl(state));
  if (autoCloseMs) closeTimer = setTimeout(closePopup, autoCloseMs);
}

function closePopup() {
  clearTimeout(closeTimer);
  if (popup && !popup.isDestroyed()) popup.close();
}

async function onAction(action) {
  if (action === 'later') return closePopup();
  if (action === 'update') {
    if (isMac) {                       // unsigned Mac apps can't self-install
      shell.openExternal(RELEASES);
      return closePopup();
    }
    show({ title: 'Downloading update...', message: 'Please wait.', progress: 0 });
    return autoUpdater.downloadUpdate().catch(() => {
      show({ title: "Couldn't download", message: 'Please try again later.', buttons: [{ label: 'Close', action: 'later' }] });
    });
  }
  if (action === 'restart') {
    await beforeInstall();             // save quiz data + skip the exit dialog
    closePopup();
    autoUpdater.quitAndInstall();
  }
}

// ── Updater events ──────────────────────────────────────────────────────────
autoUpdater.on('update-available', () => {
  finished = true;
  show({
    title: 'Update',
    message: 'Pislita ag update basin naa Updated na App',
    buttons: [
      { label: 'Later', action: 'later' },
      { label: 'Update', action: 'update', primary: true }
    ]
  });
});

autoUpdater.on('update-not-available', () => {
  finished = true;
  show({ title: 'Okie pa ag version. Updated pa ne. Padajun gamit', message: '' }, 2500);
});

autoUpdater.on('download-progress', p => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.setProgressBar(p.percent / 100);
  if (popup && !popup.isDestroyed()) {
    popup.webContents.executeJavaScript(
      `var f=document.getElementById('fill'); if(f) f.style.width='${Math.round(p.percent)}%';`
    ).catch(() => {});
  }
});

autoUpdater.on('update-downloaded', () => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.setProgressBar(-1);
  show({
    title: 'Update ready',
    message: 'Ready na ang update. Your data will be saved first, then the app restarts.',
    buttons: [
      { label: 'Later', action: 'later' },
      { label: 'Restart', action: 'restart', primary: true }
    ]
  });
});

autoUpdater.on('error', () => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.setProgressBar(-1);
  if (checking) {
    show({ title: "Couldn't check for updates", message: 'Check your internet connection.' }, 2500);
  }
});

// ── Check ───────────────────────────────────────────────────────────────────
async function check() {
  if (finished || checking || !app.isPackaged) return;
  if (!net.isOnline()) {
    if (!shownOffline) {
      shownOffline = true;
      show({ title: 'No internet connection', message: 'The app works offline. It will check again when internet returns.' }, 2500);
    }
    return;
  }
  checking = true;
  show({ title: 'paabot kadali....mangita tag update...', message: '', spinner: true });
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    /* handled by the 'error' event */
  } finally {
    checking = false;
  }
}

// Call once after the main window is created
function startAutoCheck(win, onBeforeInstall) {
  mainWin = win;
  if (onBeforeInstall) beforeInstall = onBeforeInstall;
  check();                          // every time the app opens
  const t = setInterval(() => {     // if offline at launch, retry when internet returns
    if (finished) return clearInterval(t);
    check();
  }, 30000);
}

module.exports = { startAutoCheck };
