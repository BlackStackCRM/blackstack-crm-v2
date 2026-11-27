// Electron single-instance lock diagnostic — runs INSIDE the packaged app's
// Electron runtime (dist5), loading the same electron module.
// Launch:  "dist5\win-unpacked\BlackStack CRM.exe" --locktest
// It is intercepted in main.js BEFORE requestSingleInstanceLock.
process.on('uncaughtException', (e) => { console.error('[locktest]', e.message); process.exit(3); });
const { app } = require('electron');
app.whenReady().then(async () => {
  const got = app.requestSingleInstanceLock();
  console.log('[locktest] userData(default)=', app.getPath('userData'));
  console.log('[locktest] gotLock=', got);
  app.exit(got ? 0 : 9);
});
