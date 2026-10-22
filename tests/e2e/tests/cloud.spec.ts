import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

const API = 'http://127.0.0.1:8787';

test('cloud login offers an explicit merge choice and reaches a synced state', async ({ page }) => {
  let syncRequests = 0;
  await page.route(`${API}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/v1/auth/code/request') {
      await route.fulfill({ status: 202, body: '' });
      return;
    }
    if (url.pathname === '/api/v1/auth/code/verify') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ access_token: 'e2e-access-token', expires_in: 900 }),
      });
      return;
    }
    if (url.pathname === '/api/v1/sync/bootstrap') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          entities: [],
          snapshot_cursor: '0',
          next_page: null,
          has_more: false,
        }),
      });
      return;
    }
    if (url.pathname === '/api/v1/sync') {
      syncRequests += 1;
      const body = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ack: body.ops.map((op: { op_id: string }, index: number) => ({
            op_id: op.op_id,
            server_seq: index + 1,
            status: 'applied',
          })),
          changes: [],
          next_cursor: String(body.ops.length),
          has_more: false,
          server_time: new Date().toISOString(),
        }),
      });
      return;
    }
    await route.fulfill({ status: 404, body: '{}' });
  });

  await openApp(page);
  await page.getByRole('button', { name: '设置与数据' }).click();
  await page.getByRole('button', { name: '同步', exact: true }).click();
  await page.getByLabel('API 地址').fill(API);
  await page.getByLabel('邮箱').fill('cloud-e2e@example.com');
  await page.getByRole('button', { name: '发送登录验证码' }).click();
  await page.getByLabel('验证码').fill('246810');
  await page.getByRole('button', { name: '验证并连接' }).click();

  const merge = page.locator('.cloud-merge');
  await expect(merge).toBeVisible();
  await expect(merge).toContainText('本机');
  await expect(merge).toContainText('云端');
  await expect(merge.getByRole('button', { name: '合并本机与云端' })).toBeVisible();
  await expect(merge.getByRole('button', { name: '仅使用云端数据' })).toBeVisible();
  await expect(merge.getByRole('button', { name: '先下载本机备份' })).toBeVisible();

  await merge.getByRole('button', { name: '合并本机与云端' }).click();
  await expect(page.locator('.cloud-account-card')).toContainText('已同步');
  await expect(page.locator('.cloud-account-card')).toContainText('cloud-e2e@example.com');
  expect(syncRequests).toBeGreaterThan(0);
});
