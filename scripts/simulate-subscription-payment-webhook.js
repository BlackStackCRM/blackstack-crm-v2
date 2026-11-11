require('dotenv').config();
const crypto = require('node:crypto');

const required = ['TEST_COMPANY_ID', 'TEST_SUBSCRIPTION_ID', 'TEST_AMOUNT_MINOR'];
const missing = required.filter((name) => !process.env[name]);
if (missing.length) {
  console.error(`Set the following environment values before running: ${missing.join(', ')}`);
  process.exit(2);
}

const secret = process.env.PAYMENT_WEBHOOK_SECRET;
if (!secret) {
  console.error('PAYMENT_WEBHOOK_SECRET is not configured in the environment.');
  process.exit(2);
}

const payload = {
  providerPaymentId: process.env.TEST_PAYMENT_ID || `test_${crypto.randomUUID()}`,
  companyId: process.env.TEST_COMPANY_ID,
  subscriptionId: process.env.TEST_SUBSCRIPTION_ID,
  amountMinor: Number(process.env.TEST_AMOUNT_MINOR),
  currency: 'INR',
  status: 'succeeded',
};
if (!Number.isSafeInteger(payload.amountMinor) || payload.amountMinor < 1) {
  console.error('TEST_AMOUNT_MINOR must be a positive integer (paise).');
  process.exit(2);
}

const body = JSON.stringify(payload);
const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
const baseUrl = (process.env.CRM_API_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

(async () => {
  const response = await fetch(`${baseUrl}/api/payments/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-provider-signature': signature },
    body,
  });
  const result = await response.json();
  console.log(JSON.stringify({ httpStatus: response.status, result }, null, 2));
  if (!response.ok) process.exitCode = 1;
})().catch((error) => {
  console.error('Webhook request failed:', error.message);
  process.exitCode = 1;
});
