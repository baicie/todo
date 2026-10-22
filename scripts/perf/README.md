# Performance benchmark

Direct IndexedDB dataset generator and a Playwright benchmark for the production
web preview. These scripts are QA tools, not part of the app bundle.

```bash
# 1. Build and serve the production app
pnpm --filter @todo/app build
pnpm --filter @todo/app preview --host 127.0.0.1 --port 4173 --strictPort

# 2. In another shell, run the benchmark
node scripts/perf/benchmark.mjs --sizes=100,1000,10000 --iterations=6
node scripts/perf/benchmark.mjs --sizes=100000 --iterations=3 --output=artifacts/perf-100k.json
```

`benchmark.mjs` uses the root `playwright-core` dependency and the Playwright
Chromium cache. If the browser is elsewhere, set `CHROME_PATH` to the Chrome
executable. It never edits application code or adds a debug entry point.

`seed-dataset.mjs` opens the existing `shishi-todo` IndexedDB database created
by a normal app boot, clears tasks/steps/dayPlans/mutations and writes
`Task`-shaped rows in batches. It leaves lists and meta intact so a reload
behaves like a returning user. The search benchmark uses the unique token
`zebra-target-0`.

Measurement definitions and latest numbers: [`docs/performance.md`](../../docs/performance.md).
