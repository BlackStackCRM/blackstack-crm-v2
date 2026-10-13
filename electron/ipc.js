/** Renderer -> main broadcast helper for update status. */
function sendToRenderer(channel, payload) {
  try {
    const { BrowserWindow } = require('electron');
    for (const w of BrowserWindow.getAllWindows()) {
      w.webContents.send(channel, payload);
    }
  } catch { /* window may not exist yet */ }
}

module.exports = { sendToRenderer };
