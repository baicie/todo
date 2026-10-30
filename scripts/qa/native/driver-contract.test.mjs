import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const driver = readFileSync(join(here, 'windows-toast-driver.ps1'), 'utf8');
const e2e = readFileSync(join(here, 'toast-e2e.mjs'), 'utf8');

test('UIA driver requires a unique run marker before invoke', () => {
  assert.match(driver, /RunMarker is required to attribute a notification/);
  assert.match(driver, /Test-QaMarkerText/);
  assert.match(driver, /Find-ToastCard/);
  assert.match(driver, /common ancestor|Get-CommonAncestor/);
  assert.match(driver, /no unique Toast card/);
  assert.match(e2e, /-RunMarker/);
  assert.match(e2e, /manifest\.runId/);
});

test('UIA driver never uses blind coordinate clicks or full-desktop screenshots', () => {
  assert.doesNotMatch(driver, /SetCursorPos|mouse_event|SendInput/);
  assert.match(driver, /screenshot_rejected_large/);
  assert.match(driver, /screenshot_rejected_outside_screen/);
  assert.match(driver, /container\.Current\.BoundingRectangle/);
});
