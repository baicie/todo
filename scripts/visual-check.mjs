import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5174';
await mkdir('artifacts', { recursive: true });

const errors = [];
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
});
const page = await context.newPage();
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(`console: ${message.text()}`);
});
await page.goto(APP_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(900);
await page.screenshot({ path: 'artifacts/desktop-my-day.png', fullPage: false });
const taskCount = await page.locator('.task-row').count();
const scrollWidth = await page.evaluate(() => ({
  body: document.body.scrollWidth,
  viewport: innerWidth,
}));
await page.locator('.task-row').first().click();
await page.waitForTimeout(350);
await page.screenshot({ path: 'artifacts/desktop-detail.png', fullPage: false });
await page.getByRole('button', { name: '关闭详情' }).click();
await page.getByRole('button', { name: '全部' }).first().click();
await page.waitForTimeout(300);
await page.screenshot({ path: 'artifacts/desktop-all.png', fullPage: false });
await context.close();

const mobile = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 1,
  isMobile: true,
  hasTouch: true,
});
const mobilePage = await mobile.newPage();
mobilePage.on('pageerror', (error) => errors.push(`mobile pageerror: ${error.message}`));
mobilePage.on('console', (message) => {
  if (message.type() === 'error') errors.push(`mobile console: ${message.text()}`);
});
await mobilePage.goto(APP_URL, { waitUntil: 'networkidle' });
await mobilePage.waitForTimeout(800);
await mobilePage.screenshot({ path: 'artifacts/mobile-my-day.png', fullPage: false });
const mobileScroll = await mobilePage.evaluate(() => ({
  body: document.body.scrollWidth,
  viewport: innerWidth,
}));
await mobilePage.locator('.task-row').first().click();
await mobilePage.waitForTimeout(350);
await mobilePage.screenshot({ path: 'artifacts/mobile-detail.png', fullPage: false });
await mobile.close();

console.log(JSON.stringify({ taskCount, scrollWidth, mobileScroll, errors }, null, 2));
await browser.close();
