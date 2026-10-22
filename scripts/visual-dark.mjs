import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.addInitScript(() => localStorage.setItem('shishi.theme', 'dark'));
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.goto(process.env.APP_URL ?? 'http://127.0.0.1:4173', { waitUntil: 'networkidle' });
await page.waitForSelector('.task-row');
await page.screenshot({ path: 'artifacts/desktop-dark.png' });
await page.locator('.task-row').first().click();
await page.waitForTimeout(250);
await page.screenshot({ path: 'artifacts/desktop-dark-detail.png' });
console.log(
  JSON.stringify({ errors, theme: await page.locator('html').getAttribute('data-theme') }),
);
await browser.close();
