export default async function run(page, ui) {
  // Already logged in? If we see the sign-in form, log in.
  const hasLogin = await page.locator('input[type=email]').count();
  if (hasLogin) {
    await page.fill('input[type=email]', 'admin@blackstack.local');
    await page.fill('input[type=password]', 'admin123');
    await page.click('button:has-text("SIGN IN")');
  }
  await page.waitForSelector('#page-container', { timeout: 20000 });
  await page.evaluate(() => { location.hash = '#inventory'; window.dispatchEvent(new HashChangeEvent('hashchange')); });
  await page.waitForSelector('.inv-card', { timeout: 20000 });
  await page.waitForTimeout(1500);
  return {
    url: page.url(),
    cards: await page.locator('.inv-card').count(),
    headings: await page.locator('h2').allTextContents(),
  };
}
