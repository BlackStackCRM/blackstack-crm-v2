export default async function run(page, ui) {
  const email = await ui.snapshot();
  const emailRef = email.match(/@(e\d+) (textbox|button|input)[^\n]*/);
  // Fill login form
  await page.fill('input[type=email]', 'admin@blackstack.local');
  await page.fill('input[type=password]', 'admin123');
  await page.click('button[type=submit], #login-btn, button:has-text("SIGN IN")');
  await page.waitForSelector('.inv-card', { timeout: 20000 });
  await page.waitForTimeout(800);
  return { url: page.url(), cards: await page.locator('.inv-card').count() };
}
