const base = require('@playwright/test');

const test = base.test.extend({
  page: async ({ page }, use, testInfo) => {
    const logs = [];
    page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));
    page.on('pageerror', err => logs.push(`[PAGE ERROR] ${err.message}`));

    await use(page);

    // Attach logs only if the test failed
    if (testInfo.status !== testInfo.expectedStatus && logs.length) {
      await testInfo.attach('console-logs.txt', {
        body: logs.join('\n'),
        contentType: 'text/plain',
      });
    }
  },
});

module.exports = { test, expect: base.expect };
