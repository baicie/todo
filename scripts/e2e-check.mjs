import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5174';
await mkdir('artifacts', { recursive: true });
const errors = [];
const record = (label, error) => {
  errors.push({ label, message: error?.message ?? String(error), stack: error?.stack });
};

const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (error) => record('pageerror', error));
page.on('console', (message) => {
  if (message.type() === 'error') record('console', new Error(message.text()));
});
await page.goto(APP_URL, { waitUntil: 'networkidle' });
await page.waitForSelector('.task-row');
const initialTasks = await page.locator('.task-row').count();

const input = page.getByRole('textbox', { name: '添加任务' });
await input.fill('浏览器回归任务');
await input.press('Enter');
await page.getByText('浏览器回归任务', { exact: true }).waitFor();
await page.waitForTimeout(250);

await page.getByText('浏览器回归任务', { exact: true }).click();
await page.getByRole('button', { name: '标记为完成' }).first().click();
await page.waitForTimeout(450);
const toastText = (await page.locator('.toast').count())
  ? await page.locator('.toast').textContent()
  : null;

await page.keyboard.press('Control+k');
await page.getByRole('searchbox', { name: '搜索任务' }).fill('浏览器回归');
await page.waitForTimeout(450);
const searchResults = await page.locator('.search-result').count();
await page.screenshot({ path: 'artifacts/desktop-search.png' });
await page.keyboard.press('Escape');

await page.getByRole('button', { name: '设置与数据' }).click();
await page.waitForSelector('.settings-modal');
await page.waitForTimeout(300);
await page.screenshot({ path: 'artifacts/desktop-settings.png' });
await page.getByRole('button', { name: '数据', exact: true }).click();
await page.waitForTimeout(300);
await page.screenshot({ path: 'artifacts/desktop-settings-data.png' });
await page.keyboard.press('Escape');

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
const mobilePage = await mobile.newPage();
mobilePage.on('pageerror', (error) => record('mobile pageerror', error));
mobilePage.on('console', (message) => {
  if (message.type() === 'error') record('mobile console', new Error(message.text()));
});
await mobilePage.goto(APP_URL, { waitUntil: 'networkidle' });
await mobilePage.waitForSelector('.task-row');
await mobilePage.getByRole('button', { name: '清单', exact: true }).click();
await mobilePage.waitForTimeout(300);
await mobilePage.screenshot({ path: 'artifacts/mobile-sidebar.png' });
await mobilePage.getByRole('button', { name: /^工作/ }).click();
await mobilePage.waitForTimeout(350);
await mobilePage.screenshot({ path: 'artifacts/mobile-list.png' });
await mobilePage.locator('.task-row').first().click();
await mobilePage.waitForTimeout(300);
const mobileBottomNavVisible = await mobilePage.locator('.bottom-nav').isVisible();
await mobilePage.screenshot({ path: 'artifacts/mobile-detail-final.png' });
await mobilePage.getByRole('button', { name: '关闭详情' }).click();
await mobilePage.waitForTimeout(500);
const appClassAfterClose = await mobilePage.locator('.app-shell').getAttribute('class');
const bottomNavAfterClose = await mobilePage.locator('.bottom-nav').isVisible();
await mobilePage.locator('.bottom-nav button').nth(3).click();
await mobilePage.waitForTimeout(350);
await mobilePage.screenshot({ path: 'artifacts/mobile-settings.png' });

console.log(
  JSON.stringify(
    {
      initialTasks,
      toastText,
      searchResults,
      mobileBottomNavVisible,
      appClassAfterClose,
      bottomNavAfterClose,
      errors,
    },
    null,
    2,
  ),
);
await browser.close();
