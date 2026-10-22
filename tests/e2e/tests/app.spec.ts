import { expect, test } from '@playwright/test';
import { addTask, expectNoHorizontalOverflow, openApp, taskRow, uniqueTitle } from './helpers';

test.describe('desktop my-day workflow', () => {
  test('shows my-day, adds, completes, searches, opens settings and exports JSON', async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));

    await openApp(page);
    await expect(page.getByRole('heading', { name: '我的一天', level: 1 })).toBeVisible();
    await expect(page.getByText('欢迎使用拾事', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建任务' })).toBeVisible();
    await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeVisible();

    const title = uniqueTitle('桌面回归任务');
    const row = await addTask(page, title);
    await expect(row).toBeVisible();

    await row.getByRole('button', { name: '标记为完成' }).click();
    await expect(taskRow(page, title)).toHaveCount(0);

    await page.locator('.sidebar').getByRole('button', { name: '已完成' }).click();
    await expect(page.getByRole('heading', { name: '已完成', level: 1 })).toBeVisible();
    await expect(taskRow(page, title)).toBeVisible();

    await page.keyboard.press('Control+k');
    const search = page.getByRole('searchbox', { name: '搜索任务' });
    await expect(search).toBeFocused();
    await search.fill(title);
    await expect(page.locator('.search-result').filter({ hasText: title })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(search).toBeHidden();

    await page.locator('.sidebar').getByRole('button', { name: '设置与数据' }).click();
    const dialog = page.getByRole('dialog', { name: '设置与数据' });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: '数据' }).click();
    await expect(dialog.getByRole('button', { name: '导出 JSON' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: '导出 CSV' })).toBeVisible();

    const downloadPromise = page.waitForEvent('download');
    await dialog.getByRole('button', { name: '导出 JSON' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toMatch(/\.json$/);
    await expect(dialog.getByRole('button', { name: '导出 JSON' })).toBeEnabled();

    await dialog.getByRole('button', { name: '关闭' }).click();
    await expect(dialog).toBeHidden();
    expect(pageErrors).toEqual([]);
  });
});

test.describe('mobile', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });

  test('adds a task, opens/closes detail and uses the bottom navigation', async ({ page }) => {
    await openApp(page);
    const bottomNav = page.getByRole('navigation', { name: '移动端导航' });
    await expect(bottomNav).toBeVisible();

    const title = uniqueTitle('移动端回归任务');
    const row = await addTask(page, title);
    await row.click();

    const detail = page.getByRole('complementary', { name: '任务详情' });
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('textbox', { name: '任务标题' })).toHaveValue(title);
    await expect(bottomNav).toBeHidden();

    await page.getByRole('button', { name: '关闭详情' }).click();
    await expect(detail).toBeHidden();
    await expect(bottomNav).toBeVisible();

    await bottomNav.getByRole('button', { name: '全部' }).click();
    await expect(page.getByRole('heading', { name: '全部任务', level: 1 })).toBeVisible();
    await expect(taskRow(page, title)).toBeVisible();

    await bottomNav.getByRole('button', { name: '清单' }).click();
    await expect(page.locator('.sidebar')).toHaveClass(/sidebar--open/);
    await page.locator('.sidebar__close').click();
    await expect(page.locator('.sidebar')).not.toHaveClass(/sidebar--open/);

    await bottomNav.getByRole('button', { name: '我' }).click();
    await expect(page.getByRole('dialog', { name: '设置与数据' })).toBeVisible();
  });

  test('has no horizontal overflow with the list or detail open', async ({ page }) => {
    await openApp(page);
    await expectNoHorizontalOverflow(page);

    await page.locator('.task-list .task-row').first().click();
    await expect(page.getByRole('complementary', { name: '任务详情' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
});

for (const width of [768, 1440]) {
  test(`no horizontal overflow at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await openApp(page);
    await expectNoHorizontalOverflow(page);

    await page.locator('.task-list .task-row').first().click();
    await expect(page.getByRole('complementary', { name: '任务详情' })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}
