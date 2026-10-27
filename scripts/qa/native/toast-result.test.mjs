import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyDriverResult } from './toast-result.mjs';

test('FAIL stays FAIL', () => {
  const result = classifyDriverResult({ status: 'FAIL', error: 'invoke failed' });
  assert.equal(result.status, 'FAIL');
  assert.equal(result.verifyBusiness, false);
  assert.match(result.reason, /invoke failed/);
});

test('NOT_RUN stays NOT_RUN with the concrete reason', () => {
  const result = classifyDriverResult({ status: 'NOT_RUN', error: 'no visible banner' });
  assert.equal(result.status, 'NOT_RUN');
  assert.equal(result.verifyBusiness, false);
  assert.match(result.reason, /no visible banner/);
});

test('PARTIAL continues to business verification', () => {
  const result = classifyDriverResult({ status: 'PARTIAL' });
  assert.equal(result.status, 'PARTIAL');
  assert.equal(result.verifyBusiness, true);
});

test('driver PASS is not accepted without business verification', () => {
  const result = classifyDriverResult({ status: 'PASS' });
  assert.equal(result.status, 'PASS');
  assert.equal(result.verifyBusiness, true);
  assert.match(result.reason, /not accepted/);
});

test('missing, empty, unknown and malformed results fail', () => {
  for (const driver of [undefined, null, {}, { status: '' }, { status: 'DONE' }, [], 'PASS']) {
    const result = classifyDriverResult(driver);
    assert.equal(result.status, 'FAIL');
    assert.equal(result.verifyBusiness, false);
  }
});
