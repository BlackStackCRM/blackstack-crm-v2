// Fix the LIVE APP database (Roaming userData) — seed plan + subscription.
const { DatabaseSync } = require('node:sqlite');

const LIVE_DB = 'C:/Users/BLACK STACK/AppData/Roaming/blackstack-crm-v2/database/blackstack-crm.db';
const companyId = 'default';
const now = new Date().toISOString();
const end = new Date(Date.now() + 3.15e11).toISOString(); // ~10 years

const db = new DatabaseSync(LIVE_DB);

try {
  // 1. Plan (parent of subscriptions.plan_id FK)
  const planCols = db.prepare('PRAGMA table_info(subscription_plans)').all().map(x => x.name);
  console.log('plan columns:', planCols.join(','));
  const existingPlan = db.prepare('SELECT id FROM subscription_plans LIMIT 1').get();
  const planId = existingPlan ? existingPlan.id : 'plan_qa_unlimited';
  if (!existingPlan) {
    db.prepare(`INSERT INTO subscription_plans
      (id, name, account_type, price_minor, duration_days, active, auto_renew, description, created_by, duration_unit, duration_value)
      VALUES (?, 'QA Unlimited', 'customer_tenant', 0, 3650, 1, 0, 'QA long-lived plan', 'qa-script', 'day', 3650)`)
      .run(planId);
    console.log('plan seeded:', planId);
  } else {
    console.log('plan exists:', planId);
  }
  const plan = db.prepare('SELECT id, name, account_type, duration_days, duration_unit FROM subscription_plans WHERE id = ?').get(planId);

  // 2. Subscription for company 'default'
  db.prepare(`INSERT OR REPLACE INTO subscriptions
    (id, company_id, account_type, plan_id, plan_name, amount_minor, duration_days,
     starts_at, expires_at, status, payment_status, auto_renew,
     duration_unit, duration_value, end_date)
    VALUES ('sub_qa_default', ?, ?, ?, ?, 0, ?,
            ?, ?, 'ACTIVE', 'PAID', 1,
            ?, ?, ?)`)
    .run(companyId, plan.account_type || 'customer_tenant', plan.id,
         plan.name || 'QA Unlimited', plan.duration_days || 3650,
         now, end, plan.duration_unit || 'day', plan.duration_days || 3650, end);

  // 3. Verify EXACTLY as the middleware queries
  const latest = db.prepare(
    `SELECT status, COALESCE(end_date, expires_at) AS ed
     FROM subscriptions WHERE company_id = ?
     ORDER BY created_at DESC, rowid DESC LIMIT 1`
  ).get(companyId);
  const gatePasses = latest && String(latest.status).toUpperCase() === 'ACTIVE'
    && latest.ed
    && db.prepare("SELECT datetime(?) >= datetime('now') AS v").get(latest.ed).v === 1;
  console.log('LIVE APP DB — middleware query result:', JSON.stringify(latest));
  console.log('gate passes?', gatePasses ? 'YES ✅' : 'NO ❌');
} catch (e) {
  console.log('ERROR:', e.message);
} finally {
  db.close();
}
