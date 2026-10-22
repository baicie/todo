import { chromium } from 'playwright-core';
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text());
});
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:4173';
await page.goto(APP_URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.task-row');
const input = page.getByRole('textbox', { name: '添加任务' });
await input.fill('今日回归任务');
await input.press('Enter');
await page.waitForTimeout(500);
const appearedInMyDay = await page
  .locator('.task-list .task-row', { hasText: '今日回归任务' })
  .count();

await page.getByText('今日回归任务', { exact: true }).first().click();
await page.waitForTimeout(250);
await page.locator('.detail .task-check').click();
await page.waitForTimeout(500);
const disappearedFromOpenList = await page
  .locator('.task-list .task-row', { hasText: '今日回归任务' })
  .count();
await page.locator('.detail__close').click();
await page
  .getByRole('button', { name: /已完成/ })
  .first()
  .click();
await page.waitForTimeout(350);
const appearedInCompleted = await page.locator('.task-row', { hasText: '今日回归任务' }).count();

await page
  .getByRole('button', { name: /我的一天/ })
  .first()
  .click();
await page.waitForTimeout(300);
await page.getByText('收件箱清空', { exact: true }).first().click();
await page.waitForTimeout(200);
await page.getByRole('button', { name: '删除任务' }).click();
await page.waitForTimeout(350);
const toastVisible = await page.locator('.toast').isVisible();
await page.locator('.toast__action').click();
await page.waitForTimeout(450);
const restored = await page.getByText('收件箱清空', { exact: true }).count();

console.log(
  JSON.stringify(
    {
      appearedInMyDay,
      disappearedFromOpenList,
      appearedInCompleted,
      toastVisible,
      restored,
      errors,
    },
    null,
    2,
  ),
);
await browser.close();
