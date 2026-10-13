const { chromium } = require('@playwright/test');
(async () => {
  console.log('1. Importing chromium...');
  console.log('2. Attempting to launch browser...');
  try {
    const browser = await chromium.launch({
      headless: false,
      timeout: 30000,
    });
    console.log('3. Browser launched!');
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    console.log('4. Context created!');
    const page = await context.newPage();
    console.log('5. Page created!');
    await page.goto('http://localhost:3000/login.html', { timeout: 15000 });
    console.log('6. Navigated to login!');
    await browser.close();
    console.log('7. Done!');
    process.exit(0);
  } catch(e) {
    console.error('ERROR:', e.message);
    console.error(e.stack);
    process.exit(1);
  }
})();
