// RC2-D.15 Phase B: observation helpers for the Windows notification platform.
//
// The harness could prove schedule + cancel but never delivery, so a reminder
// that never reached Windows was indistinguishable from a delivered one. These
// helpers read the per-AUMID notification registry that Windows itself writes
// when it accepts a toast, and poll it with a bounded state loop so a test can
// stop the moment the observation is satisfied instead of sleeping blindly.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

export const NOTIFICATIONS_SETTINGS_KEY =
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Notifications\\Settings';

const FILETIME_TICKS_PER_MS = 10000n;
const FILETIME_UNIX_EPOCH_OFFSET_MS = 11644473600000n;

export const REMINDER_LAYERS = [
  'REMINDER_SCHEDULED',
  'NATIVE_TRIGGER_FIRED',
  'WINDOWS_API_ACCEPTED',
  'OS_NOTIFICATION_OBSERVED',
  'NOTIFICATION_CENTER_VISIBLE',
  'BANNER_VISIBLE',
  'CLICK_ACTIVATED',
  'DETAIL_OPENED_ACK',
];

// Hard rule: a registry change may justify OS_NOTIFICATION_OBSERVED at most.
// Seeing a banner, the notification center or a click needs eyes on the
// desktop, which this harness does not have.
const INTERACTION_LAYERS = [
  'NOTIFICATION_CENTER_VISIBLE',
  'BANNER_VISIBLE',
  'CLICK_ACTIVATED',
  'DETAIL_OPENED_ACK',
];

export const INTERACTION_LAYER_REASON =
  'not observable here: the harness cannot see a banner, the notification center or a click';

export const DELIVERY_LAYERS = ['OS_NOTIFICATION_OBSERVED', ...INTERACTION_LAYERS];

// Match the worker's own diagnostics (apps/native/src-tauri/src/reminders.rs).
// A failure line proves the timer thread ran and the platform rejected the
// toast; a success leaves no line at all.
const REMINDER_ATTEMPT_PATTERNS = [
  /shishi: desktop reminder notification failed: (.*)/,
  /shishi: reminder skipped because notifications are not permitted/,
  /shishi: could not read notification permission: (.*)/,
  /shishi: notification action registration failed: (.*)/,
];

export function filetimeToIso(ticks) {
  const value = typeof ticks === 'bigint' ? ticks : BigInt(ticks);
  const ms = Number(value / FILETIME_TICKS_PER_MS - FILETIME_UNIX_EPOCH_OFFSET_MS);
  return { ms, iso: new Date(ms).toISOString() };
}

/**
 * Read the Windows notification settings key for one AUMID.
 *
 * LastNotificationAddedTime is a FILETIME that Windows advances when it
 * accepts a notification for that AUMID, so it is only meaningful as a
 * before/after comparison - never as an absolute delivery claim.
 */
export function readNotificationSettings(aumid) {
  const key = `${NOTIFICATIONS_SETTINGS_KEY}\\${aumid}`;
  const observedAtMs = Date.now();
  let output;
  try {
    output = execFileSync('reg', ['query', key], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error).trim();
    return {
      key,
      exists: false,
      observedAtMs,
      observedAt: new Date(observedAtMs).toISOString(),
      error: detail,
      values: {},
      lastNotificationAddedTimeHex: null,
      lastNotificationAddedTimeTicks: null,
      lastNotificationAddedAt: null,
      lastNotificationAddedAtMs: null,
    };
  }
  const values = {};
  let ticks = null;
  for (const line of output.split(/\r?\n/)) {
    const match = /^\s+(\S+)\s+REG_(QWORD|DWORD|SZ)\s+(.+?)\s*$/.exec(line);
    if (!match) continue;
    values[match[1]] = match[3];
    if (match[1] === 'LastNotificationAddedTime' && /^0x[0-9a-fA-F]+$/i.test(match[3])) {
      ticks = BigInt(match[3]);
    }
  }
  const stamp = ticks === null ? null : filetimeToIso(ticks);
  return {
    key,
    exists: true,
    observedAtMs,
    observedAt: new Date(observedAtMs).toISOString(),
    values,
    lastNotificationAddedTimeHex: ticks === null ? null : `0x${ticks.toString(16)}`,
    lastNotificationAddedTimeTicks: ticks === null ? null : ticks.toString(),
    lastNotificationAddedAt: stamp === null ? null : stamp.iso,
    lastNotificationAddedAtMs: stamp === null ? null : stamp.ms,
  };
}

/** True only when Windows advanced the counter, i.e. accepted a new toast. */
export function notificationAdvanced(baseline, current) {
  if (!baseline?.exists || !current?.exists) return false;
  if (!baseline.lastNotificationAddedTimeTicks || !current.lastNotificationAddedTimeTicks) {
    return false;
  }
  return BigInt(current.lastNotificationAddedTimeTicks) > BigInt(baseline.lastNotificationAddedTimeTicks);
}

export function notificationDeltaMs(baseline, current) {
  if (!notificationAdvanced(baseline, current)) return null;
  return Number(
    (BigInt(current.lastNotificationAddedTimeTicks) - BigInt(baseline.lastNotificationAddedTimeTicks)) /
      FILETIME_TICKS_PER_MS,
  );
}

/** Read only what the app appended to its redirected stderr since the offset. */
export function readAppendedText(file, offset) {
  try {
    const { size } = fs.statSync(file);
    if (size <= offset) return { text: '', offset: size, exists: true };
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      return { text: buffer.toString('utf8'), offset: size, exists: true };
    } finally {
      fs.closeSync(fd);
    }
  } catch (error) {
    return { text: '', offset, exists: false, error: String(error?.message || error) };
  }
}

export function reminderAttemptLines(text) {
  const lines = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (REMINDER_ATTEMPT_PATTERNS.some((pattern) => pattern.test(line))) lines.push(line.trim());
  }
  return lines;
}

/**
 * Bounded state polling: probe, stop as soon as the observation is satisfied,
 * otherwise stop at the deadline. Never sleeps past the bound.
 */
export async function pollUntil({ timeoutMs, intervalMs, probe, satisfied }) {
  const startedMs = Date.now();
  let polls = 0;
  let last = null;
  let observed = false;
  for (;;) {
    polls += 1;
    last = probe();
    observed = Boolean(satisfied(last));
    const elapsedMs = Date.now() - startedMs;
    if (observed || elapsedMs >= timeoutMs) {
      return { satisfied: observed, polls, elapsedMs, last };
    }
    const remaining = timeoutMs - elapsedMs;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, remaining)));
  }
}

export function buildLayerReport() {
  const report = {};
  for (const layer of REMINDER_LAYERS) {
    report[layer] = INTERACTION_LAYERS.includes(layer)
      ? { status: 'NOT_RUN', evidence: INTERACTION_LAYER_REASON }
      : { status: 'NOT_RUN', evidence: 'not observed by this test' };
  }
  return report;
}

export function setLayer(report, layer, status, evidence) {
  if (!LAYER_SET.has(layer)) throw new Error(`unknown reminder layer ${layer}`);
  if (!['PASS', 'FAIL', 'NOT_RUN'].includes(status)) {
    throw new Error(`layer ${layer} has invalid status ${status}`);
  }
  report[layer] = { status, evidence };
  return report;
}

const LAYER_SET = new Set(REMINDER_LAYERS);

/** Layers that would be claiming a user-visible delivery. */
export function deliveryClaims(report) {
  return DELIVERY_LAYERS.filter((layer) => report[layer]?.status === 'PASS');
}

/** Guard the hard rule mechanically instead of trusting each call site. */
export function assertNoUnobservableClaims(report) {
  const claimed = INTERACTION_LAYERS.filter((layer) => report[layer]?.status !== 'NOT_RUN');
  if (claimed.length > 0) {
    throw new Error(`unobservable layer claimed: ${claimed.join(', ')}`);
  }
  return true;
}

export function layerSummary(report) {
  return REMINDER_LAYERS.map((layer) => `${layer}=${report[layer]?.status ?? 'NOT_RUN'}`).join(' ');
}
