import { expect, test, type Page } from '@playwright/test';
import { addTask, openApp, uniqueTitle } from './helpers';

/**
 * The notification ACK waits for the detail component to commit the target task
 * into its rendered output. That output is this aside, and its title textarea is
 * what the panel actually rendered, so the real DOM is asserted here instead of
 * trusting an App-side signal.
 */
function detailAside(page: Page) {
  return page.getByRole('complementary', { name: '任务详情' });
}

test.describe('detail render confirmation', () => {
  test('selecting a task renders the detail aside with its title', async ({ page }) => {
    await openApp(page);
    const title = uniqueTitle('详情确认');
    const row = await addTask(page, title);

    await row.click();

    const detail = detailAside(page);
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('textbox', { name: '任务标题' })).toHaveValue(title);
    // The confirming party is the panel's own output, not an App signal.
    await expect(detail.locator('.detail__title')).toHaveValue(title);
    await expect(detail.locator('.detail__title')).toBeVisible();
  });

  test('closing unmounts the aside and reopening renders only the new task', async ({ page }) => {
    await openApp(page);
    const first = uniqueTitle('详情关闭');
    const second = uniqueTitle('详情重开');
    await addTask(page, first);
    await addTask(page, second);

    await page.locator('.task-list .task-row').filter({ hasText: first }).click();
    await expect(detailAside(page).getByRole('textbox', { name: '任务标题' })).toHaveValue(first);

    await page.getByRole('button', { name: '关闭详情' }).click();
    await expect(detailAside(page)).toHaveCount(0);

    await page.locator('.task-list .task-row').filter({ hasText: second }).click();
    const detail = detailAside(page);
    await expect(detail).toBeVisible();
    await expect(detail.getByRole('textbox', { name: '任务标题' })).toHaveValue(second);
    await expect(detail.getByRole('textbox', { name: '任务标题' })).not.toHaveValue(first);
  });
});
