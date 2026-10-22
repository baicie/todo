import { expect, test } from '@playwright/test';
import { addTask, openApp, taskRow, uniqueTitle } from './helpers';

test('web account profiles keep local databases isolated', async ({ page }) => {
  page.on('dialog', (dialog) => void dialog.accept());
  await openApp(page);
  const first = uniqueTitle('默认空间任务');
  await addTask(page, first);

  await page.locator('.sidebar').getByRole('button', { name: '设置与数据' }).click();
  const dialog = page.getByRole('dialog', { name: '设置与数据' });
  await dialog.getByRole('button', { name: '同步' }).click();
  await dialog.getByRole('button', { name: '添加账号' }).click();
  await page.waitForLoadState('domcontentloaded');
  await expect(page.getByRole('textbox', { name: '添加任务' })).toBeVisible();
  await expect(taskRow(page, first)).toHaveCount(0);

  const second = uniqueTitle('第二空间任务');
  await addTask(page, second);
  await page.locator('.sidebar').getByRole('button', { name: '设置与数据' }).click();
  const secondDialog = page.getByRole('dialog', { name: '设置与数据' });
  await secondDialog.getByRole('button', { name: '同步' }).click();
  await secondDialog.getByRole('button', { name: '切换' }).click();
  await page.waitForLoadState('domcontentloaded');
  await expect(taskRow(page, first)).toBeVisible();
  await expect(taskRow(page, second)).toHaveCount(0);
});
