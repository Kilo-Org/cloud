import assert from 'node:assert/strict';
import test from 'node:test';
import { getWranglerRegistryPath } from './wrangler-registry';

test('keeps the Wrangler registry beneath the current worktree', () => {
  assert.equal(
    getWranglerRegistryPath('/tmp/worktrees/feature-a'),
    '/tmp/worktrees/feature-a/.wrangler/dev-registry'
  );
});

test('gives equal-basename worktrees distinct Wrangler registries', () => {
  assert.notEqual(
    getWranglerRegistryPath('/tmp/worktrees-a/cloud'),
    getWranglerRegistryPath('/tmp/worktrees-b/cloud')
  );
});
