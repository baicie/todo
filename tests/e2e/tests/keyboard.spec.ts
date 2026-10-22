import { expect, test } from '@playwright/test';
import { addTask, openApp, taskRow, uniqueTitle } from './helpers';

test('Control+K opens a focused search and Escape restores focus', async ({ page }) => {
  await openApp(page);
  const trigger = page.locator('.sidebar .search-trigger');
  await trigger.click();
  const search = page.getByRole('searchbox', { name: '搜索任务' });
  await expect(search).toBeFocused();

  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press('Control+k');
  await expect(search).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(search).toBeHidden();
});

test('Control+N focuses quick add and Space completes the focused task', async ({ page }) => {
  await openApp(page);
  const input = page.getByRole('textbox', { name: '添加任务' });
  const title = uniqueTitle('键盘任务');

  await page.keyboard.press('Control+n');
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute('aria-label', '添加任务');

  await input.fill(title);
  await input.press('Enter');
  const row = taskRow(page, title);
  await expect(row).toBeVisible();

  // The row container is not focusable; the title button owns the Space
  // shortcut and opens the detail panel on Enter.
  const titleButton = row.getByRole('button', { name: new RegExp(title) });
  await titleButton.focus();
  await page.keyboard.press('Space');
  await expect(taskRow(page, title)).toHaveCount(0);

  await page.locator('.sidebar').getByRole('button', { name: '已完成' }).click();
  await expect(taskRow(page, title)).toBeVisible();
});

test('settings dialog traps focus and restores it to the trigger', async ({ page }) => {
  await openApp(page);
  const trigger = page.locator('.sidebar').getByRole('button', { name: '设置与数据' });
  await trigger.click();

  const dialog = page.getByRole('dialog', { name: '设置与数据' });
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null))
    .toBe(true);

  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  expect(
    await page.evaluate(() => document.activeElement?.closest('[role="dialog"]') !== null),
  ).toBe(true);

  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});
