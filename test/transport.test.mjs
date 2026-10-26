import test from 'node:test';
import assert from 'node:assert/strict';
import { runTransportSmoke } from '../scripts/transport-smoke.mjs';

test('real DSH HTTP transport authenticates, applies changes and unloads cleanly', {
  skip: !process.env.DSH_SDK_ROOT && 'DSH_SDK_ROOT unset: real transport was not exercised',
}, async () => {
  const report = await runTransportSmoke();
  assert.equal(report.status, 'PASS');
});
