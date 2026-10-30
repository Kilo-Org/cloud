import assert from 'node:assert/strict';
import test from 'node:test';

import { createSampler } from '../../../apps/mobile/src/lib/design-gate/sampler';

test('sampling retains late transitions without merging non-adjacent layouts', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  let position = 0;
  const sampler = createSampler(() => ({
    env: { route: '/fixture' },
    nodes: [{ rect: [position, 0, 10, 10] }],
  }));
  sampler.start(120, 60_000);
  for (position = 1; position <= 401; position += 1) context.mock.timers.tick(120);
  position = 399;
  context.mock.timers.tick(120);
  const samples = sampler.stop();
  assert.equal(samples.length, 400);
  assert.equal(sampler.truncated(), true);
  assert.deepEqual(
    samples.slice(-3).map(sample => [sample.dump.nodes[0]?.rect[0], sample.repeat]),
    [
      [400, 1],
      [401, 1],
      [399, 1],
    ]
  );
});

test('stopping a sampler releases its timers and does not retain later captures', context => {
  context.mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'] });
  let captures = 0;
  const sampler = createSampler(() => {
    captures += 1;
    return { env: { route: '/fixture' }, nodes: [{ rect: [captures, 0, 10, 10] }] };
  });
  sampler.start(120, 5_000);
  context.mock.timers.tick(120);
  const stoppedAt = captures;
  sampler.stop();
  context.mock.timers.tick(10_000);
  assert.equal(captures, stoppedAt);
  assert.deepEqual(sampler.stop(), []);
});
