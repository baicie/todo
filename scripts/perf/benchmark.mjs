#!/usr/bin/env node
/**
 * Cold/warm reload, list query, search typing and JS-heap benchmark for the
 * production web preview.
 *
 * Usage:
 *   pnpm --filter @todo/app build
 *   pnpm --filter @todo/app preview --host 127.0.0.1 --port 4173
 *   node scripts/perf/benchmark.mjs --sizes=100,1000,10000
 *   node scripts/perf/benchmark.mjs --sizes=100000 --iterations=2
 *
 * The browser is the locally installed Playwright Chromium (or CHROME_PATH).
 * It uses the root `playwright-core` dependency so the benchmark never changes
 * the app's dependency graph.
 */
import { chromium } from 'playwright-core';
import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem, platform, release } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { seedDataset, waitForAppReady } from './seed-dataset.mjs';

const args = parseArgs(process.argv.slice(2));
const APP_URL = args.url ?? process.env.APP_URL ?? 'http://127.0.0.1:4173';
const sizes = (args.sizes ?? '100,1000,10000')
  .split(',')
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0);
const iterations = Math.max(2, Number.parseInt(args.iterations ?? '4', 10));
const outputPath = path.resolve(args.output ?? 'artifacts/perf-results.json');

if (sizes.length === 0) {
  console.error('No valid --sizes supplied.');
  process.exit(1);
}

const executablePath = process.env.CHROME_PATH || chromium.executablePath();
const browser = await chromium.launch({ executablePath, headless: true });
const results = {
  appUrl: APP_URL,
  generatedAt: new Date().toISOString(),
  machine: {
    platform: `${platform()} ${release()}`,
    cpu: cpus()[0]?.model ?? 'unknown',
    logicalCpus: cpus().length,
    totalMemoryGiB: Number((totalmem() / 1024 ** 3).toFixed(1)),
    node: process.version,
    browser: browser.version(),
  },
  method: {
    reload: 'wall clock: page.reload start -> quick-add visible and loading skeleton removed',
    coldReload:
      'first reload after unregistering the service worker, deleting Cache Storage and disabling the HTTP cache via CDP',
    warmReload: `same reload with the service worker + HTTP cache warm (${iterations - 1} measured runs, before opening the large list)`,
    listQuery:
      'click "全部任务" -> first .task-row visible (includes getCounts scan, the 500-row data load and virtualized first paint)',
    search:
      'immediately after a warm reload, fill the search box with a unique 5+ char token -> first .search-result visible (includes the app 120 ms debounce; measured before opening the large list so virtualizer settling does not contaminate it)',
    memory:
      'Chrome DevTools Protocol Performance.getMetrics JSHeapUsedSize after the list view is rendered',
  },
  sizes: [],
};

try {
  for (const size of sizes) {
    console.log(`\n=== ${size} tasks ===`);
    results.sizes.push(await runSize(size));
  }
} finally {
  await browser.close();
}

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(results, null, 2)}\n`, 'utf8');
console.log(`\nWrote ${outputPath}`);
printSummary(results);

async function runSize(taskCount) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
  console.log('  seeding IndexedDB...');
  const seed = await seedDataset(page, taskCount);
  console.log(
    `  seeded ${seed.taskCount} tasks in ${seed.seedDurationMs.toFixed(0)} ms (${(
      (seed.storageUsageBytes ?? 0) /
      1024 ** 2
    ).toFixed(1)} MiB storage)`,
  );

  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Performance.enable');

  // Real "cold-ish" reload: no service worker, no Cache Storage, no HTTP cache.
  await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
  });
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  const coldMs = await measureReload(page);
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: false });
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, null, {
    timeout: 120_000,
  });

  // One unmeasured warm reload fills the service worker runtime cache.
  await measureReload(page);
  const warm = [];
  for (let index = 0; index < iterations - 1; index += 1) {
    warm.push(await measureReload(page));
  }

  // Search is measured from a clean default view. Opening the virtualized list
  // first leaves the renderer busy for several seconds and would contaminate
  // the next measurement.
  const search = [];
  for (let index = 0; index < Math.min(3, iterations - 1); index += 1) {
    await measureReload(page);
    search.push(await measureSearch(page));
  }

  // Each list measurement starts from a fresh reload so the previous
  // virtualizer instance cannot affect it.
  const list = [];
  for (let index = 0; index < Math.min(3, iterations - 1); index += 1) {
    await measureReload(page);
    list.push(await measureListQuery(page));
  }

  // Let the virtualizer finish measuring, then force GC so the JS heap is
  // comparable across datasets and not polluted by discarded reloads.
  await page.waitForTimeout(1_000);
  await cdp.send('HeapProfiler.enable');
  await cdp.send('HeapProfiler.collectGarbage');
  await page.waitForTimeout(250);
  const metrics = await cdp.send('Performance.getMetrics');
  const jsHeapUsed = metrics.metrics.find((metric) => metric.name === 'JSHeapUsedSize')?.value;
  const jsHeapTotal = metrics.metrics.find((metric) => metric.name === 'JSHeapTotalSize')?.value;
  const domNodes = metrics.metrics.find((metric) => metric.name === 'Nodes')?.value;
  const jsHeapFromPage = await page.evaluate(() => {
    const memory = performance.memory;
    return memory
      ? {
          used: memory.usedJSHeapSize,
          total: memory.totalJSHeapSize,
          limit: memory.jsHeapSizeLimit,
        }
      : null;
  });
  const counts = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open('shishi-todo');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const count = (store) =>
      new Promise((resolve, reject) => {
        const request = db.transaction(store, 'readonly').objectStore(store).count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    const result = {
      tasks: await count('tasks'),
      steps: await count('steps'),
      dayPlans: await count('dayPlans'),
      mutations: await count('mutations'),
    };
    db.close();
    return result;
  });

  await context.close();
  const summary = {
    tasks: taskCount,
    seedDurationMs: round(seed.seedDurationMs),
    storageMiB: seed.storageUsageBytes ? round(seed.storageUsageBytes / 1024 ** 2, 2) : null,
    coldReloadMs: round(coldMs),
    warmReloadMs: warm.map(round),
    warmReloadMedianMs: round(median(warm)),
    warmReloadP95Ms: round(percentile(warm, 0.95)),
    listQueryMs: list.map(round),
    listQueryMedianMs: round(median(list)),
    listQueryP95Ms: round(percentile(list, 0.95)),
    searchTypingMs: search.map(round),
    searchTypingMedianMs: round(median(search)),
    searchTypingP95Ms: round(percentile(search, 0.95)),
    jsHeapUsedMiB: jsHeapUsed ? round(jsHeapUsed / 1024 ** 2, 2) : null,
    jsHeapTotalMiB: jsHeapTotal ? round(jsHeapTotal / 1024 ** 2, 2) : null,
    jsHeapFromPageMiB: jsHeapFromPage ? round(jsHeapFromPage.used / 1024 ** 2, 2) : null,
    domNodes: domNodes ?? null,
    dbCounts: counts,
    pageErrors,
  };
  console.log('  ' + JSON.stringify(summary));
  return summary;
}

async function measureReload(page) {
  const started = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForAppReady(page);
  return Date.now() - started;
}

async function measureListQuery(page) {
  await page.locator('.sidebar').getByRole('button', { name: '我的一天' }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('h1')?.textContent === '我的一天' &&
      document.querySelector('.task-skeleton') === null,
  );
  const started = Date.now();
  await page.locator('.sidebar').getByRole('button', { name: '全部任务' }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('h1')?.textContent === '全部任务' &&
      document.querySelectorAll('.task-list .task-row').length > 0,
  );
  return Date.now() - started;
}

async function measureSearch(page) {
  await page.keyboard.press('Control+k');
  const input = page.getByRole('searchbox', { name: '搜索任务' });
  await input.waitFor({ state: 'visible' });
  if ((await input.inputValue()).length > 0) {
    await input.fill('');
    await page.waitForTimeout(250);
  }
  const started = Date.now();
  await input.fill('zebra-target-0');
  await page.locator('.search-result').first().waitFor({ state: 'visible' });
  const duration = Date.now() - started;
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  return duration;
}

function median(values) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function percentile(values, ratio) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

function round(value, digits = 1) {
  return Number.isFinite(value) ? Number(value.toFixed(digits)) : null;
}

function printSummary(output) {
  console.log('\nTasks | cold reload | warm median | list median | search median | JS heap');
  console.log('----- | ----------- | ----------- | ----------- | ------------- | -------');
  for (const row of output.sizes) {
    console.log(
      `${row.tasks} | ${row.coldReloadMs} ms | ${row.warmReloadMedianMs} ms | ${row.listQueryMedianMs} ms | ${row.searchTypingMedianMs} ms | ${row.jsHeapUsedMiB} MiB`,
    );
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (match) parsed[match[1]] = match[2];
  }
  return parsed;
}
