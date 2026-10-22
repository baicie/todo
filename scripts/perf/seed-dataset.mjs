/**
 * Seed a deterministic task dataset directly into the app's IndexedDB.
 *
 * The generator is intentionally Playwright-only: the application source must
 * not grow a debug endpoint. It opens the existing `shishi-todo` database
 * (created by a normal app boot), writes Dexie-compatible Task rows and leaves
 * lists/meta alone, so the next reload behaves like a real returning user.
 */

export const SEARCH_TOKEN = 'zebra-target-0';

export async function waitForAppReady(page) {
  await page.waitForSelector('.quick-add__input', { state: 'visible', timeout: 120_000 });
  await page.waitForFunction(() => document.querySelector('.task-skeleton') === null, null, {
    timeout: 120_000,
  });
}

/**
 * @param {import('playwright-core').Page} page
 * @param {number} taskCount
 * @param {{batchSize?: number}} [options]
 */
export async function seedDataset(page, taskCount, options = {}) {
  return page.evaluate(
    async ({ count, batchSize, searchToken }) => {
      const openDb = () =>
        new Promise((resolve, reject) => {
          const request = indexedDB.open('shishi-todo');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const txDone = (tx) =>
        new Promise((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
          tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
        });
      const getAll = (db, storeName) =>
        new Promise((resolve, reject) => {
          const request = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });

      const db = await openDb();
      for (const storeName of ['tasks', 'steps', 'dayPlans', 'mutations']) {
        if (!db.objectStoreNames.contains(storeName)) {
          throw new Error(`Missing IndexedDB object store: ${storeName}`);
        }
      }
      const lists = await getAll(db, 'lists');
      const listIds = lists.filter((list) => !list.deletedAt).map((list) => list.id);

      const clearTx = db.transaction(['tasks', 'steps', 'dayPlans', 'mutations'], 'readwrite');
      clearTx.objectStore('tasks').clear();
      clearTx.objectStore('steps').clear();
      clearTx.objectStore('dayPlans').clear();
      clearTx.objectStore('mutations').clear();
      await txDone(clearTx);

      const now = new Date().toISOString();
      const today = new Date();
      const localDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(
        2,
        '0',
      )}-${String(today.getDate()).padStart(2, '0')}`;
      const started = performance.now();

      const makeTask = (index) => {
        const rank = index.toString(36).padStart(6, '0');
        const title =
          index === 0
            ? `任务 000000 · ${searchToken}`
            : `任务 ${String(index).padStart(6, '0')} · 场景 ${index % 10}`;
        return {
          id: `perf-task-${String(index).padStart(7, '0')}`,
          listId: listIds.length > 0 ? listIds[index % listIds.length] : null,
          title,
          note: index % 97 === 0 ? `批量生成的任务备注 ${index}` : '',
          status: 'open',
          important: index % 11 === 0,
          dueOn: index % 7 === 0 ? localDate : null,
          remindAt: null,
          remindTimezone: null,
          rank,
          seriesId: null,
          occurrenceKey: index % 7 === 0 ? localDate : null,
          recurrence: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
          deletedAt: null,
        };
      };

      const size = Math.max(100, Math.min(batchSize, 5000));
      for (let start = 0; start < count; start += size) {
        const end = Math.min(count, start + size);
        const tx = db.transaction('tasks', 'readwrite');
        const store = tx.objectStore('tasks');
        for (let index = start; index < end; index += 1) store.put(makeTask(index));
        await txDone(tx);
      }

      const durationMs = performance.now() - started;
      const taskCountAfter = await new Promise((resolve, reject) => {
        const request = db.transaction('tasks', 'readonly').objectStore('tasks').count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const estimate = navigator.storage?.estimate ? await navigator.storage.estimate() : null;
      db.close();
      return {
        taskCount: taskCountAfter,
        listCount: listIds.length,
        seedDurationMs: durationMs,
        storageUsageBytes: estimate?.usage ?? null,
        storageQuotaBytes: estimate?.quota ?? null,
      };
    },
    { count: taskCount, batchSize: options.batchSize ?? 1000, searchToken: SEARCH_TOKEN },
  );
}
