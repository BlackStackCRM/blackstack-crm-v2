/**
 * Tiny TCP listener check.
 *
 * The destructive E2E suites bind port 3000 and refuse to start when something
 * already holds it — that guard exists because a stale server means the suite
 * runs against someone else's database and wipes it. That refusal is correct, but
 * during a release gate it surfaces as an unexplained failure.
 *
 * Checking the port before launching makes the cause explicit.
 */
const net = require('net');

/** Resolve true when something is already listening on `port`. */
function portBusy(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

/** Resolve true when nothing holds `port`. */
async function portFree(port, timeoutMs = 1500) {
  return !(await portBusy(port, timeoutMs));
}

module.exports = { portBusy, portFree };