import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';

const BASE = 'http://127.0.0.1:4173';
const API = 'http://127.0.0.1:8787';
const EMAIL = `e2e-${Date.now()}@example.com`;
const browser = await chromium.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
});
await mkdir('artifacts', { recursive: true });
const errors = [];

const newDevice = async (name) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    serviceWorkers: 'block',
    acceptDownloads: true,
  });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${name}: ${message.text()}`);
  });
  page.on('response', async (response) => {
    if (response.url().includes(':8787')) {
      errors.push(`${name}: HTTP ${response.status()} ${response.url()}`);
    }
  });
  page.on('requestfailed', (request) => {
    if (request.url().includes(':8787')) {
      errors.push(`${name}: FAILED ${request.url()} ${request.failure()?.errorText}`);
    }
  });
  return { context, page, name };
};

const openSync = async (page) => {
  await page.getByRole('button', { name: '设置与数据' }).click();
  await page.getByRole('button', { name: '同步', exact: true }).click();
  await page.locator('.cloud-panel').waitFor();
};

const login = async (page, email) => {
  await openSync(page);
  await page.getByLabel('API 地址').fill(API);
  await page.getByLabel('邮箱').fill(email);
  await page.getByRole('button', { name: '发送登录验证码' }).click();
  await page.getByLabel('验证码').waitFor();
  await page.getByLabel('验证码').fill('246810');
  await page.getByRole('button', { name: '验证并连接' }).click();
  try {
    await page.waitForSelector('.cloud-merge, .cloud-account-card', { timeout: 20000 });
  } catch (error) {
    console.log('LOGIN FAILED PANEL:', await page.locator('.cloud-panel').innerText());
    console.log('LOGIN FAILED ERRORS:', errors);
    await page.screenshot({ path: 'artifacts/cloud-login-failed.png' });
    throw error;
  }
};

const closeSettings = async (page) => {
  await page.keyboard.press('Escape');
  await page.locator('.settings-modal').waitFor({ state: 'detached' });
};

const waitSynced = async (page, timeout = 20000) => {
  await page.locator('.sync-pill', { hasText: '已同步' }).waitFor({ timeout });
};

const allView = async (page) => {
  await page
    .getByRole('button', { name: /全部任务/ })
    .first()
    .click();
};

const addTask = async (page, title) => {
  const input = page.getByRole('textbox', { name: '添加任务' });
  await input.fill(title);
  await input.press('Enter');
  await page.getByText(title, { exact: true }).first().waitFor();
};

const findTask = async (page, title) => {
  await page.keyboard.press('Control+K');
  const search = page.getByRole('searchbox', { name: '搜索任务' });
  await search.waitFor();
  await search.fill(title);
  await page.waitForTimeout(400);
  return page.getByText(title, { exact: true }).first().isVisible();
};

const deviceA = await newDevice('A');
const deviceB = await newDevice('B');
try {
  await deviceA.page.goto(BASE, { waitUntil: 'networkidle' });
  await allView(deviceA.page);
  await addTask(deviceA.page, '设备A本地任务');

  await login(deviceA.page, EMAIL);
  const mergeTextA = await deviceA.page.locator('.cloud-merge').innerText();
  await deviceA.page.getByRole('button', { name: '合并本机与云端' }).click();
  await deviceA.page.locator('.cloud-account-card').waitFor({ timeout: 20000 });
  await closeSettings(deviceA.page);
  await waitSynced(deviceA.page);
  await allView(deviceA.page);

  await deviceB.page.goto(BASE, { waitUntil: 'networkidle' });
  await login(deviceB.page, EMAIL);
  const mergeTextB = await deviceB.page.locator('.cloud-merge').innerText();
  if (process.env.MERGE_B === '1') {
    await deviceB.page.getByRole('button', { name: '合并本机与云端' }).click();
  } else {
    deviceB.page.once('dialog', (dialog) => dialog.accept());
    await deviceB.page.getByRole('button', { name: '仅使用云端数据' }).click();
  }
  await deviceB.page.locator('.cloud-account-card').waitFor({ timeout: 20000 });
  await closeSettings(deviceB.page);
  await waitSynced(deviceB.page);
  await allView(deviceB.page);
  const sawATaskOnB = await findTask(deviceB.page, '设备A本地任务');
  await deviceB.page.keyboard.press('Escape');

  await addTask(deviceB.page, '设备B在线任务');
  await waitSynced(deviceB.page);

  await allView(deviceA.page);
  await deviceA.page.reload({ waitUntil: 'networkidle' });
  await waitSynced(deviceA.page);
  await allView(deviceA.page);
  const sawBOnlineOnA = await findTask(deviceA.page, '设备B在线任务');
  await deviceA.page.keyboard.press('Escape');

  await deviceB.context.setOffline(true);
  await addTask(deviceB.page, '设备B离线任务');
  const offlineLabel = await deviceB.page.locator('.sync-pill').innerText();
  await deviceB.context.setOffline(false);
  await waitSynced(deviceB.page, 30000);

  await deviceA.page.reload({ waitUntil: 'networkidle' });
  await waitSynced(deviceA.page);
  await allView(deviceA.page);
  const sawOfflineOnA = await findTask(deviceA.page, '设备B离线任务');
  await deviceA.page.keyboard.press('Escape');

  await openSync(deviceA.page);
  const diagnostics = await deviceA.page.locator('.cloud-panel').innerText();
  await deviceA.page.screenshot({ path: 'artifacts/cloud-real-connected.png' });

  console.log(
    JSON.stringify(
      {
        email: EMAIL,
        mergeTextA,
        mergeTextB,
        sawATaskOnB,
        sawBOnlineOnA,
        offlineLabel,
        sawOfflineOnA,
        diagnostics,
        errors,
      },
      null,
      2,
    ),
  );
} finally {
  await deviceA.context.close();
  await deviceB.context.close();
  await browser.close();
}
