import { expect, type Locator, type Page } from '@playwright/test';

export const APP_TITLE = '拾事';

export function uniqueTitle(prefix: string): string {
  return `${prefix} ${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

/**
 * Opens the production preview and waits until the initial IndexedDB read has
 * replaced the loading skeleton. Every Playwright test gets a fresh browser
 * context, so the seeded demo data is deterministic.
 */
export async function openApp(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('textbox', { name: '添加任务' })).toBeVisible();
  await expect(page.locator('.task-skeleton')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
}

export function taskRow(page: Page, title: string): Locator {
  return page.locator('.task-list .task-row').filter({ hasText: title });
}

export async function addTask(page: Page, title: string): Promise<Locator> {
  const input = page.getByRole('textbox', { name: '添加任务' });
  await input.fill(title);
  await input.press('Enter');
  const row = taskRow(page, title);
  await expect(row).toBeVisible();
  await expect(input).toHaveValue('');
  return row;
}

/** Assert the document does not horizontally scroll at the current viewport. */
export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
  // Layout transitions (e.g. opening the detail column) can briefly expose a
  // 1-4px intermediate width. Poll until the transition settles instead of
  // using a fixed sleep; a genuine overflow keeps failing until the timeout.
  await expect
    .poll(
      async () =>
        page.evaluate(() => {
          const scrollWidth = Math.max(
            document.documentElement.scrollWidth,
            document.body.scrollWidth,
          );
          return scrollWidth - window.innerWidth;
        }),
      { message: 'document should not scroll horizontally', timeout: 3_000 },
    )
    .toBeLessThanOrEqual(1);
}

/** Visible buttons must expose a name from aria-label, title, or text content. */
export async function expectVisibleButtonsNamed(page: Page): Promise<void> {
  const unnamed = await page.locator('button:visible').evaluateAll((buttons) =>
    buttons
      .filter((button) => {
        const label = button.getAttribute('aria-label')?.trim();
        const title = button.getAttribute('title')?.trim();
        const text = (button.textContent ?? '').replace(/\s+/g, ' ').trim();
        return !(label || title || text);
      })
      .map((button) => button.outerHTML.slice(0, 160)),
  );
  expect(unnamed, `buttons without an accessible name: ${unnamed.join('\n')}`).toEqual([]);
}
