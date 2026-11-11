const { getConn } = require('../utils/db');
const { WalletSubscriptionService } = require('./walletSubscription.service');

let timer = null;
let busy = false;

function startSubscriptionRenewalWorker() {
  if (timer) return;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      const service = new WalletSubscriptionService(getConn());
      await service.renewDue();
      service.expireDue();
    }
    catch (err) { console.error('[subscriptions] Renewal worker pass failed:', err.message); }
    finally { busy = false; }
  };
  // Run once on boot and then every five minutes. The due-time query and
  // idempotency key make overlapping/restarted worker passes safe.
  run();
  timer = setInterval(run, 5 * 60 * 1000);
  if (timer.unref) timer.unref();
}

function stopSubscriptionRenewalWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}

module.exports = { startSubscriptionRenewalWorker, stopSubscriptionRenewalWorker };
