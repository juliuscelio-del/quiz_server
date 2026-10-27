const { app, BrowserWindow, net, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES = 'https://github.com/juliuscelio-del/quiz_server/releases/latest';
const isMac = process.platform === 'darwin';

// How long the result popups stay on screen (milliseconds)
const UP_TO_DATE_MS = 10000;   // "Okie pa ag version..." popup
const NOTICE_MS = 4000;        // offline / error popups

// Popup window size (includes 20px around the card for the shadow)
const W = 480, H = 300;

autoUpdater.autoDownload = false;

let mainWin = null;
let beforeInstall = async () => {};
let popup = null;
let closeTimer = null;
let checking = false;
let finished = false;      // a check completed (found / not found)
let shownOffline = false;

// ── Icons (inline SVG) ──────────────────────────────────────────────────────
const SVG = (path) =>
  `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round">${path}</svg>`;
const ICONS = {
  check:    SVG('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
  download: SVG('<path d="M12 4v11M7 11l5 5 5-5M5 20h14"/>'),
  alert:    SVG('<path d="M12 6v7M12 17.5v.5"/>')
};

// ── Popup page (HTML + CSS) ─────────────────────────────────────────────────
function pageUrl({ title, message, icon = 'check', spinner, progress, buttons = [], countdown }) {
  const btns = buttons.map(b =>
    `<button class="${b.primary ? 'p' : ''}" onclick="location.href='gnhs://${b.action}'">${b.label}</button>`
  ).join('');

  const iconHtml = spinner
    ? '<div class="ring"></div>'
    : `<div class="icon ${icon === 'alert' ? 'warn' : ''}">${ICONS[icon] || ICONS.check}</div>`;

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box}
    html,body{height:100%;margin:0;background:transparent;overflow:hidden;
      font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;user-select:none;-webkit-user-select:none}
    body{padding:20px}
    .card{position:relative;height:100%;border-radius:22px;overflow:hidden;
      background:linear-gradient(165deg,#ffffff 0%,#f0f9f2 100%);
      border:1px solid #dcefe2;box-shadow:0 18px 50px rgba(20,60,35,.28),0 2px 8px rgba(20,60,35,.12);
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      text-align:center;padding:26px 28px 30px;
      -webkit-app-region:drag;animation:pop .28s ease-out both}
    .card::before{content:"";position:absolute;top:0;left:0;right:0;height:6px;
      background:linear-gradient(90deg,#2e7d32,#66bb6a,#2e7d32)}
    @keyframes pop{from{opacity:0;transform:scale(.93) translateY(10px)}to{opacity:1;transform:none}}
    .x{position:absolute;top:12px;right:14px;width:28px;height:28px;border:none;border-radius:50%;
      background:transparent;color:#8a9a8f;font-size:18px;line-height:28px;cursor:pointer;padding:0;-webkit-app-region:no-drag}
    .x:hover{background:#e6f2e9;color:#2e7d32}
    .icon{width:68px;height:68px;border-radius:50%;margin:0 0 14px;display:flex;align-items:center;justify-content:center;
      background:linear-gradient(135deg,#43a047,#2e7d32);box-shadow:0 8px 20px rgba(46,125,50,.35)}
    .icon.warn{background:linear-gradient(135deg,#ffa726,#ef6c00);box-shadow:0 8px 20px rgba(239,108,0,.35)}
    .ring{width:56px;height:56px;margin:6px 0 20px;border-radius:50%;
      border:5px solid #d7ecdc;border-top-color:#2e7d32;animation:spin .9s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
    h2{margin:0 0 8px;font-size:19px;line-height:1.35;font-weight:700;color:#1b4332}
    p{margin:0 0 4px;color:#5b6b61;font-size:14px;line-height:1.5}
    .row{margin-top:18px;display:flex;gap:10px;justify-content:center;-webkit-app-region:no-drag}
    button.b,.row button{padding:10px 26px;border:1px solid #cfe3d4;border-radius:999px;background:#fff;color:#2e5d3a;
      font-size:14px;font-weight:600;cursor:pointer;transition:all .15s}
    .row button:hover{background:#f0f9f2}
    .row button.p{background:linear-gradient(135deg,#43a047,#2e7d32);color:#fff;border-color:#2e7d32;
      box-shadow:0 6px 16px rgba(46,125,50,.35)}
    .row button.p:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(46,125,50,.45)}
    .bar{width:82%;height:10px;background:#dcefe2;border-radius:999px;overflow:hidden;margin-top:16px}
    .bar div{height:100%;border-radius:999px;background:linear-gradient(90deg,#43a047,#81c784);
      width:${progress || 0}%;transition:width .25s}
    .cd{position:absolute;left:0;bottom:0;height:5px;background:linear-gradient(90deg,#66bb6a,#2e7d32);
      animation:cd ${countdown || 0}ms linear forwards}
    @keyframes cd{from{width:100%}to{width:0}}
  </style></head><body>
    <div class="card">
      <button class="x" onclick="location.href='gnhs://later'" title="Close">&times;</button>
      ${iconHtml}
      <h2>${title}</h2>
      ${message ? `<p>${message}</p>` : ''}
      ${progress != null ? '<div class="bar"><div id="fill"></div></div>' : ''}
      ${btns ? `<div class="row">${btns}</div>` : ''}
      ${countdown ? '<div class="cd"></div>' : ''}
    </div>
  </body></html>`;
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(html);
}

// ── Popup window (centered on the laptop screen) ────────────────────────────
function show(state, autoCloseMs) {
  clearTimeout(closeTimer);
  if (!popup || popup.isDestroyed()) {
    const ref = mainWin && !mainWin.isDestroyed()
      ? screen.getDisplayMatching(mainWin.getBounds())
      : screen.getPrimaryDisplay();
    const wa = ref.workArea;

    popup = new BrowserWindow({
      width: W, height: H,
      x: Math.round(wa.x + (wa.width - W) / 2),
      y: Math.round(wa.y + (wa.height - H) / 2),
      frame: false, transparent: true, hasShadow: false,
      backgroundColor: '#00000000',
      resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, show: false, alwaysOnTop: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false }
    });
    popup.setAlwaysOnTop(true, 'floating');
    popup.once('ready-to-show', () => { if (popup && !popup.isDestroyed()) popup.show(); });
    popup.on('closed', () => { popup = null; });
    popup.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith('gnhs://')) return;
      e.preventDefault();
      onAction(url.replace('gnhs://', '').replace(/\/$/, ''));
    });
  }
  popup.loadURL(pageUrl(Object.assign({}, state, { countdown: autoCloseMs })));
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
    show({ title: 'Downloading update...', message: 'Please wait.', icon: 'download', progress: 0 });
    return autoUpdater.downloadUpdate().catch(() => {
      show({
        title: "Couldn't download", message: 'Please try again later.', icon: 'alert',
        buttons: [{ label: 'Close', action: 'later' }]
      });
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
    icon: 'download',
    buttons: [
      { label: 'Later', action: 'later' },
      { label: 'Update', action: 'update', primary: true }
    ]
  });
});

autoUpdater.on('update-not-available', () => {
  finished = true;
  show({ title: 'Okie pa ag version. Updated pa ne. Padajun gamit', icon: 'check' }, UP_TO_DATE_MS);
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
    icon: 'check',
    buttons: [
      { label: 'Later', action: 'later' },
      { label: 'Restart', action: 'restart', primary: true }
    ]
  });
});

autoUpdater.on('error', () => {
  if (mainWin && !mainWin.isDestroyed()) mainWin.setProgressBar(-1);
  if (checking) {
    show({ title: "Couldn't check for updates", message: 'Check your internet connection.', icon: 'alert' }, NOTICE_MS);
  }
});

// ── Check ───────────────────────────────────────────────────────────────────
async function check() {
  if (finished || checking || !app.isPackaged) return;
  if (!net.isOnline()) {
    if (!shownOffline) {
      shownOffline = true;
      show({
        title: 'No internet connection',
        message: 'The app works offline. It will check again when internet returns.',
        icon: 'alert'
      }, NOTICE_MS);
    }
    return;
  }
  checking = true;
  show({ title: 'paabot kadali....mangita tag update...', spinner: true });
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
