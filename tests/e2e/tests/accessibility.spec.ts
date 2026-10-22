import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { expectVisibleButtonsNamed, openApp } from './helpers';

/**
 * WCAG A/AA is a hard gate: every axe finding fails the suite. When a new
 * violation appears, fix it or document a reviewed exception in docs/accessibility.md
 * together with a narrowly scoped allowlist entry here.
 */
async function expectNoAxeViolations(page: Page, state: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const details = results.violations
    .map(
      (violation) =>
        `${violation.id} (${violation.impact}): ${violation.nodes
          .map((node) => node.target.join(' '))
          .join(', ')}`,
    )
    .join('\n');
  expect(results.violations, `${state}: axe violations\n${details}`).toEqual([]);
}

test('desktop landmarks and accessible names', async ({ page }) => {
  await openApp(page);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('complementary', { name: '主导航' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '移动端导航' })).toBeHidden();
  await expect(page.locator('.sidebar nav')).toHaveCount(1);

  await expect(page.getByRole('textbox', { name: '添加任务' })).toBeVisible();
  await expect(page.getByRole('button', { name: '搜索', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '新建任务' })).toBeVisible();
  await expect(page.getByRole('button', { name: '设置与数据' })).toBeVisible();
  await expect(page.locator('.sidebar').getByRole('button', { name: '我的一天' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectVisibleButtonsNamed(page);
});

test('mobile landmarks and bottom navigation names', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  await expect(page.getByRole('main')).toHaveCount(1);
  await expect(page.getByRole('complementary', { name: '主导航' })).toHaveCount(1);
  const bottomNav = page.getByRole('navigation', { name: '移动端导航' });
  await expect(bottomNav).toBeVisible();
  for (const name of ['今天', '全部', '清单', '我']) {
    await expect(bottomNav.getByRole('button', { name })).toBeVisible();
  }
  await expectVisibleButtonsNamed(page);
});

test('search dialog has an accessible name', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press('Control+k');
  await expect(page.getByRole('dialog', { name: '搜索任务' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: '搜索任务' })).toBeHidden();
});

test('settings theme radiogroup switches the document theme', async ({ page }) => {
  await openApp(page);
  await page.locator('.sidebar').getByRole('button', { name: '设置与数据' }).click();
  const dialog = page.getByRole('dialog', { name: '设置与数据' });
  await expect(dialog.getByRole('button', { name: '桌面', exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('radiogroup', { name: '主题' })).toBeVisible();
  await dialog.getByRole('radio', { name: '深色' }).click();
  await expect(dialog.getByRole('radio', { name: '深色' })).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('dark');
  await dialog.getByRole('button', { name: '关闭' }).click();
});

test('axe WCAG A/AA scan: desktop, mobile, dark and settings', async ({ page }) => {
  await openApp(page);
  await expectNoAxeViolations(page, 'desktop light');

  await page.locator('.sidebar').getByRole('button', { name: '设置与数据' }).click();
  const dialog = page.getByRole('dialog', { name: '设置与数据' });
  await dialog.getByRole('radio', { name: '深色' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.waitForTimeout(200);
  await expectNoAxeViolations(page, 'desktop dark + settings');
  await dialog.getByRole('button', { name: '关闭' }).click();

  await page.setViewportSize({ width: 390, height: 844 });
  await expectNoAxeViolations(page, 'mobile light');

  await page.locator('.task-list .task-row').first().click();
  await expect(page.getByRole('complementary', { name: '任务详情' })).toBeVisible();
  await expectNoAxeViolations(page, 'mobile detail');
});
