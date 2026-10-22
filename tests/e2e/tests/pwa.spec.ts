import { expect, test } from '@playwright/test';
import { addTask, openApp, uniqueTitle } from './helpers';

/**
 * Requires the production preview: App.tsx only registers /sw.js when
 * import.meta.env.PROD. The Playwright config starts `vite preview` by default.
 */
test('service worker serves the app offline and local tasks survive', async ({ page, context }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('textbox', { name: '添加任务' })).toBeVisible();

  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    return {
      scope: ready.scope,
      active: ready.active?.state,
      controlled: Boolean(navigator.serviceWorker.controller),
    };
  });
  expect(registration.active).toBe('activated');
  expect(registration.scope).toBe(new URL('/', page.url()).href);
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);

  const title = uniqueTitle('离线任务');
  await addTask(page, title);

  // Cache the shell and assets under the service worker, then reload online.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await openApp(page);
  await expect(page.getByText(title, { exact: true })).toBeVisible();

  const offlineTitle = uniqueTitle('离线新增');
  await context.setOffline(true);
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByRole('heading', { name: '我的一天', level: 1 })).toBeVisible();
    await expect(page.getByText(title, { exact: true })).toBeVisible();
    expect(await page.evaluate(() => navigator.onLine)).toBe(false);

    // The local-first promise also covers edits made while offline.
    await addTask(page, offlineTitle);
  } finally {
    await context.setOffline(false);
  }

  await page.reload({ waitUntil: 'domcontentloaded' });
  await openApp(page);
  await expect(page.getByText(title, { exact: true })).toBeVisible();
  await expect(page.getByText(offlineTitle, { exact: true })).toBeVisible();
});

test('manifest is served with installable metadata', async ({ request }) => {
  const response = await request.get('/manifest.webmanifest');
  expect(response.status()).toBe(200);
  const manifest = await response.json();
  expect(manifest.name).toBe('拾事');
  expect(manifest.start_url).toBe('/');
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((icon: { sizes: string }) => icon.sizes === '192x192')).toBe(true);
});
