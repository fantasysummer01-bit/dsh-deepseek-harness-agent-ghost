import test from 'node:test';
import assert from 'node:assert/strict';
import { runHostSmoke } from '../scripts/host-smoke.mjs';

test('real installed Cordis activates Ghost and releases services and writer lease', {
  skip: process.env.DSH_SDK_ROOT ? false : 'DSH_SDK_ROOT unset: real Host integration was not run; this is not a pass',
}, async () => {
  const report = await runHostSmoke();
  assert.equal(report.status, 'PASS');
});
