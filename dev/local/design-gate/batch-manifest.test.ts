import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseShard,
  resolveTemplates,
  shardBatches,
  TemplateError,
  type SeedMap,
} from './batch-manifest';

const ids = ['T2-G09a', 'T1-G02', 'Gauth', 'T1-G11a', 'T2-G12', 'T1-G13a', 'T2-auth03'];

test('shards partition the batches and ignore manifest order', () => {
  const batches = ids.map(id => ({ id }));
  const shards = [1, 2, 3].map(index => shardBatches(batches, { index, count: 3 }).map(b => b.id));
  assert.deepEqual(shards.flat().sort(), [...ids].sort());
  assert.equal(new Set(shards.flat()).size, ids.length);
  const reversed = [1, 2, 3].map(index =>
    shardBatches([...batches].reverse(), { index, count: 3 }).map(b => b.id)
  );
  assert.deepEqual(reversed, shards);
  assert.deepEqual(shards[0], ['Gauth', 'T1-G13a', 'T2-auth03']);
});

test('a shard flag outside 1..n is rejected', () => {
  assert.deepEqual(parseShard('2/4'), { index: 2, count: 4 });
  for (const bad of ['0/2', '3/2', '1/0', '1', 'a/b']) assert.throws(() => parseShard(bad));
});

const seeds: SeedMap = {
  email: 'kilo-e2e-a1@example.com',
  createdAt: '2026-11-19T00:00:00.000Z',
  steps: {
    'security-findings': {
      topic: 'app:security-agent-findings',
      ok: true,
      values: { openFindingId: '7e6d9528-5c6e-4c46-af6a-1b8ca8bc93d5', dismissedFindingId: null },
    },
    'review-list': { topic: 'code-reviews:review-list', ok: false, values: {}, error: 'exit 1' },
  },
};

test('seed templates resolve to the seeded ids', () => {
  assert.equal(
    resolveTemplates(
      'kiloapp:///(app)/security-agent/personal/findings/{{seed:security-findings.openFindingId}}',
      seeds
    ),
    'kiloapp:///(app)/security-agent/personal/findings/7e6d9528-5c6e-4c46-af6a-1b8ca8bc93d5'
  );
  assert.equal(
    resolveTemplates('kiloapp:///(app)/(tabs)/(0_home)', undefined),
    'kiloapp:///(app)/(tabs)/(0_home)'
  );
});

test('a missing id fails with every unresolved reference named', () => {
  const link =
    'kiloapp:///x/{{seed:security-findings.dismissedFindingId}}/{{seed:review-list.newestReviewId}}/{{seed:org-pair.ownerOrganizationId}}/{{seed:security-findings.nope}}';
  assert.throws(
    () => resolveTemplates(link, seeds),
    (error: unknown) =>
      error instanceof TemplateError &&
      error.message.includes('security-findings printed no dismissedFindingId') &&
      error.message.includes('seed step review-list failed') &&
      error.message.includes('seed step org-pair did not run') &&
      error.message.includes('printed no nope')
  );
  assert.throws(
    () => resolveTemplates('kiloapp:///x/{{seed:org-pair.ownerOrganizationId}}', undefined),
    /no --seeds map/
  );
  assert.throws(() => resolveTemplates('kiloapp:///x/{{org-pair}}', seeds), /not a \{\{seed/);
});
