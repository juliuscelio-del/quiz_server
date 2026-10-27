const { app, BrowserWindow, net, shell, screen } = require('electron');
const { autoUpdater } = require('electron-updater');

const RELEASES = 'https://github.com/juliuscelio-del/quiz_server/releases/latest';
const isMac = process.platform === 'darwin';

// How long the result popups stay on screen (milliseconds)
const UP_TO_DATE_MS = 10000;   // "Okie pa ag version..." popup
const NOTICE_MS = 4000;        // offline / error popups
const CHECK_FAILSAFE_MS = 60000; // if a check hangs this long, let the popup close so nobody is stuck

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
let locked = false;        // true while the popup must not be closed by the student (checking / countdown / downloading)
let forceClose = false;    // set when the app itself closes the popup

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
      font-family:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"SF Pro Text",Roboto,sans-serif;
      -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;
      user-select:none;-webkit-user-select:none}
    body{padding:20px}
    .card{position:relative;height:100%;border-radius:22px;overflow:hidden;
      background:linear-gradient(165deg,#ffffff 0%,#eef8f0 100%);
      border:1px solid #d3eada;box-shadow:0 18px 50px rgba(20,60,35,.28),0 2px 8px rgba(20,60,35,.12);
      display:flex;flex-direction:column;align-items:center;justify-content:center;
      text-align:center;padding:30px 34px 34px;
      -webkit-app-region:drag;animation:pop .28s ease-out both}
    .card::before{content:"";position:absolute;top:0;left:0;right:0;height:6px;
      background:linear-gradient(90deg,#2e7d32,#66bb6a,#2e7d32)}
    @keyframes pop{from{opacity:0;transform:scale(.93) translateY(10px)}to{opacity:1;transform:none}}
    .icon{width:68px;height:68px;border-radius:50%;margin:0 0 16px;display:flex;align-items:center;justify-content:center;
      background:linear-gradient(135deg,#43a047,#2e7d32);box-shadow:0 8px 20px rgba(46,125,50,.35)}
    .icon.warn{background:linear-gradient(135deg,#ffa726,#ef6c00);box-shadow:0 8px 20px rgba(239,108,0,.35)}
    .ring{width:56px;height:56px;margin:4px 0 22px;border-radius:50%;
      border:5px solid #d7ecdc;border-top-color:#2e7d32;animation:spin .9s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}

    /* ── text ── */
    h2{margin:0 0 10px;max-width:380px;font-size:21px;line-height:1.3;font-weight:750;letter-spacing:-.01em;
      color:#14432c;text-wrap:balance;overflow-wrap:break-word}
    h2::after{content:"";display:block;width:34px;height:3px;margin:12px auto 0;border-radius:99px;
      background:linear-gradient(90deg,#66bb6a,#2e7d32)}
    p{margin:2px 0 0;max-width:360px;font-size:15px;line-height:1.6;font-weight:450;color:#46594d;
      text-wrap:pretty;overflow-wrap:break-word}

    .row{margin-top:20px;display:flex;gap:10px;justify-content:center;-webkit-app-region:no-drag}
    .row button{padding:11px 28px;border:1px solid #cfe3d4;border-radius:999px;background:#fff;color:#2e5d3a;
      font-family:inherit;font-size:14px;font-weight:650;letter-spacing:.01em;cursor:pointer;transition:all .15s}
    .row button:hover{background:#f0f9f2}
    .row button.p{background:linear-gradient(135deg,#43a047,#2e7d32);color:#fff;border-color:#2e7d32;
      box-shadow:0 6px 16px rgba(46,125,50,.35)}
    .row button.p:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(46,125,50,.45)}
    .bar{width:82%;height:10px;background:#dcefe2;border-radius:999px;overflow:hidden;margin-top:18px}
    .bar div{height:100%;border-radius:999px;background:linear-gradient(90deg,#43a047,#81c784);
      width:${progress || 0}%;transition:width .25s}
    .cd{position:absolute;left:0;bottom:0;height:5px;background:linear-gradient(90deg,#66bb6a,#2e7d32);
      animation:cd ${countdown || 0}ms linear forwards}
    @keyframes cd{from{width:100%}to{width:0}}
    @media (prefers-reduced-motion:reduce){*{animation-duration:.01s!important}}
  </style></head><body>
    <div class="card">
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
  // The student cannot close the popup while it is checking, counting down or downloading.
  // Popups with their own buttons (Later / Update / Restart / Close) stay closable through those buttons.
  locked = !!(state.spinner || autoCloseMs || state.progress != null);

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
    popup.on('close', e => { if (locked && !forceClose) e.preventDefault(); });   // blocks Alt+F4 / Cmd+W while locked
    popup.on('closed', () => { popup = null; forceClose = false; });
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
  locked = false;
  if (popup && !popup.isDestroyed()) {
    forceClose = true;
    popup.close();
  }
}

// never let the locked popup block the app from quitting
app.on('before-quit', () => { forceClose = true; });

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
  // safety net: if the check hangs, unlock and close the popup so the student is never stuck
  const failsafe = setTimeout(closePopup, CHECK_FAILSAFE_MS);
  try {
    await autoUpdater.checkForUpdates();
  } catch (e) {
    /* handled by the 'error' event */
  } finally {
    clearTimeout(failsafe);
    checking = false;
  }
}

// Call once after the main window is created
function startAutoCheck(win, onBeforeInstall) {
  mainWin = win;
  if (onBeforeInstall) beforeInstall = onBeforeInstall;
  if (win && win.on) win.on('closed', closePopup);   // closing the app never leaves the popup behind
  check();                          // every time the app opens
  const t = setInterval(() => {     // if offline at launch, retry when internet returns
    if (finished) return clearInterval(t);
    check();
  }, 30000);
}

module.exports = { startAutoCheck };
