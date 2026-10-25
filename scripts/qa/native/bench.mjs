import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { chromium } from 'playwright-core';

const artifactRoot = process.env.QA_ARTIFACT_ROOT;
const cdp = `http://127.0.0.1:${process.env.QA_CDP_PORT || '9345'}`;
if (!artifactRoot) throw new Error('QA_ARTIFACT_ROOT is required');
const sizes = (process.env.QA_BENCH_SIZES || '1000')
  .split(',')
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isSafeInteger(value) && value > 0);
const runs = Math.max(1, Math.min(10, Number(process.env.QA_BENCH_RUNS || 3)));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = new Date();
const samples = [];

async function connect() {
  let last;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const browser = await chromium.connectOverCDP(cdp, { timeout: 3000 });
      const page = browser
        .contexts()
        .flatMap((context) => context.pages())
        .find((candidate) => candidate.url().includes('tauri.localhost'));
      if (page) return { browser, page };
      await browser.close().catch(() => {});
    } catch (error) {
      last = error;
    }
    await sleep(500);
  }
  throw new Error(`CDP unavailable: ${last?.message ?? 'timeout'}`);
}

const { browser, page } = await connect();
await page.waitForFunction(() => Boolean(window.__TAURI_INTERNALS__), undefined, {
  timeout: 30000,
});

// Benchmarks replace the whole store. Refuse to touch a non-QA binary.
const identityResult = await page.evaluate(async () => {
  try {
    return { ok: true, value: await window.__TAURI_INTERNALS__.invoke('qa_build_identity') };
  } catch (error) {
    return {
      ok: false,
      error: typeof error === 'string' ? error : (error?.message ?? String(error)),
    };
  }
});
const identity = identityResult.ok ? identityResult.value : null;
if (!identity?.isQa || identity.identifier !== 'app.shishi.todo.qa') {
  throw new Error(`QA identity guard failed before benchmark: ${JSON.stringify(identityResult)}`);
}

async function invoke(command, args = {}) {
  return page.evaluate(
    async ({ command, args }) => {
      try {
        return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(command, args) };
      } catch (error) {
        return {
          ok: false,
          error: typeof error === 'string' ? error : (error?.message ?? String(error)),
        };
      }
    },
    { command, args },
  );
}

async function storage(action, payload = {}) {
  return invoke('todo_storage', { request: { action, payload } });
}

function unwrap(result, label) {
  if (!result?.ok) throw new Error(`${label}: ${JSON.stringify(result?.error)}`);
  return result.value;
}

function bundle(count, run) {
  const stamp = new Date().toISOString();
  const tasks = [];
  for (let index = 0; index < count; index += 1) {
    tasks.push({
      id: randomUUID(),
      listId: null,
      title: `RC2D perf ${count} task ${String(index).padStart(6, '0')}`,
      note: '',
      tags: [],
      status: 'open',
      important: false,
      dueOn: null,
      remindAt: null,
      remindTimezone: null,
      rank: `${String(index + 1).padStart(9, '0')}`,
      seriesId: null,
      occurrenceKey: null,
      recurrence: null,
      completedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
      deletedAt: null,
    });
  }
  return {
    format: 'todo-export',
    version: 1,
    exportedAt: stamp,
    appVersion: '1.0.0-rc2d',
    tasks,
    lists: [],
    steps: [],
    dayPlans: [],
    run,
  };
}

for (const size of sizes) {
  for (let run = 1; run <= runs; run += 1) {
    const input = bundle(size, run);
    const begin = Date.now();
    unwrap(
      await storage('import_data', { bundle: input, mode: 'replace' }),
      `import_data ${size}/${run}`,
    );
    const elapsedMs = Date.now() - begin;
    const counts = unwrap(
      await storage('get_counts', { localDate: new Date().toISOString().slice(0, 10) }),
      'get_counts',
    );
    const sample = {
      scenario: `import_${size}`,
      size,
      run,
      elapsedMs,
      tasksPerSecond: Math.round((size / elapsedMs) * 1000),
      allCount: counts?.all,
      generatedAt: new Date().toISOString(),
    };
    samples.push(sample);
    console.log(JSON.stringify(sample));
  }
}

const bySize = new Map();
for (const sample of samples) {
  const values = bySize.get(sample.size) || [];
  values.push(sample.elapsedMs);
  bySize.set(sample.size, values);
}
const summaries = [...bySize.entries()].map(([size, values]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) =>
    sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
  return {
    scenario: `import_${size}`,
    size,
    runs: values.length,
    minMs: sorted[0],
    p50Ms: percentile(50),
    p95Ms: percentile(95),
    maxMs: sorted[sorted.length - 1],
  };
});

const performance = {
  generatedAt: new Date().toISOString(),
  kind: 'Windows QA import benchmark',
  sizes,
  runs,
  notes: [
    'Each run imports a real todo-export bundle through the WebView IPC into the QA SQLite store in replace mode.',
    'This measures import throughput, not desktop cold-start or cloud outbox upload.',
  ],
  summaries,
  samples,
};
fs.writeFileSync(path.join(artifactRoot, 'performance.json'), JSON.stringify(performance, null, 2));
fs.writeFileSync(
  path.join(artifactRoot, 'tests.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      status: 'BENCH_ONLY',
      counts: { PASS: 1, FAIL: 0, NOT_RUN: 0, BENCH_ONLY: 1 },
      tests: [
        {
          name: 'qa_import_benchmark',
          status: 'BENCH_ONLY',
          durationMs: samples.reduce((total, sample) => total + sample.elapsedMs, 0),
          detail: { sizes, runs, samples: samples.length },
        },
      ],
    },
    null,
    2,
  ),
);
fs.writeFileSync(
  path.join(artifactRoot, 'summary.md'),
  [
    '# RC2-D Native Import Benchmark',
    '',
    `- Sizes: ${sizes.join(', ') || 'none'}`,
    `- Runs per size: ${runs}`,
    `- Samples: ${samples.length}`,
    `- Duration: ${Date.now() - startedAt.getTime()} ms`,
    '',
    '| Size | Runs | Min ms | P50 ms | P95 ms | Max ms |',
    '| ---: | ---: | ---: | ---: | ---: | ---: |',
    ...summaries.map(
      (item) =>
        `| ${item.size} | ${item.runs} | ${item.minMs} | ${item.p50Ms} | ${item.p95Ms} | ${item.maxMs} |`,
    ),
  ].join('\n'),
);
await browser.close().catch(() => {});
process.exit(0);
