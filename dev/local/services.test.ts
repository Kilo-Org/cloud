import assert from 'node:assert/strict';
import test from 'node:test';

import { getAlwaysOnGroupIds, getService, resolveGroups } from './services';

test('starts auto model classifier as a core dev service', () => {
  const service = getService('cloudflare-auto-model-classifier');

  assert.equal(service.group, 'core');
  assert.equal(service.type, 'worker');
  assert.equal(service.dir, 'services/auto-model-classifier');
  assert.equal(service.port, 8810);
  assert.match(service.command.join(' '), /pnpm run dev/);
  assert.ok(resolveGroups(getAlwaysOnGroupIds()).includes('cloudflare-auto-model-classifier'));
});
