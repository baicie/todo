#!/usr/bin/env node
/**
 * Enforce the measured web performance budgets from docs/performance.md.
 *
 * Usage: node scripts/perf/check-budget.mjs [artifacts/perf-100k-full.json]
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'artifacts/perf-100k-full.json';
const payload = JSON.parse(readFileSync(file, 'utf8'));
const samples = payload.sizes ?? payload;
const budgets = {
  10000: { warmReloadMedianMs: 1_500, listQueryMedianMs: 250, searchTypingMedianMs: 400 },
  100000: { warmReloadMedianMs: 2_500, listQueryMedianMs: 300, searchTypingMedianMs: 500 },
};

let failed = false;
for (const sample of samples) {
  const budget = budgets[sample.tasks];
  if (!budget) continue;
  for (const [key, limit] of Object.entries(budget)) {
    const value = sample[key];
    const ok = typeof value === 'number' && value <= limit;
    if (!ok) failed = true;
    console.log(`${ok ? 'PASS' : 'FAIL'} ${sample.tasks} ${key}=${value} budget=${limit}`);
  }
}
if (failed) process.exit(1);
