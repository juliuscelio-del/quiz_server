// Safe bridge between the dashboard page and the desktop app.
// Only exposes the Save action; the page gets no other Node/Electron powers.
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("gnhsApp", {
  isDesktop: true,
  saveNow: () => ipcRenderer.invoke("gnhs:save-now"),
  onSaveRequested: (cb) => ipcRenderer.on("gnhs:save-requested", () => cb()),
});
