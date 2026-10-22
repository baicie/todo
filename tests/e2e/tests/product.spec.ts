import { expect, test } from '@playwright/test';
import { openApp, taskRow, uniqueTitle } from './helpers';

test.describe('product v1.1', () => {
  test('tags, calendar, saved filters and weekly review are usable', async ({ page }) => {
    await openApp(page);
    const title = uniqueTitle('标签任务');
    const input = page.getByRole('textbox', { name: '添加任务' });
    await input.fill(`${title} #发布 今天`);
    await input.press('Enter');
    const row = taskRow(page, title);
    await expect(row).toBeVisible();
    await expect(row.locator('.tag-chip').filter({ hasText: '#发布' })).toBeVisible();

    await page.locator('.sidebar').getByRole('button', { name: '日历' }).click();
    await expect(page.locator('.calendar-view')).toBeVisible();
    await expect(page.locator('.calendar-task').filter({ hasText: title })).toBeVisible();

    await page.locator('.sidebar').getByRole('button', { name: '每周回顾' }).click();
    await expect(page.getByRole('dialog', { name: '每周回顾' })).toBeVisible();
    await page.getByRole('button', { name: '关闭' }).click();

    await page.locator('.sidebar').getByRole('button', { name: '我的一天' }).click();
    await expect(taskRow(page, title)).toBeVisible();
    await page.locator('.filter-trigger').click();
    await page.locator('.filter-tag').filter({ hasText: '#发布' }).click();
    await expect(taskRow(page, title)).toBeVisible();
    await page.getByRole('button', { name: '清除筛选' }).click();
    await expect(taskRow(page, title)).toBeVisible();
  });
});
