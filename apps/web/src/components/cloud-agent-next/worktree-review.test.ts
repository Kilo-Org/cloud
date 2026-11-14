import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { MAX_WORKTREE_REVIEW_PROMPT_LENGTH } from '@kilocode/app-shared/worktree-review';
import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@kilocode/cloud-agent-sdk/limits';

jest.mock('../../../node_modules/@pierre/diffs/dist/utils/iterateOverDiff.js', () => ({
  iterateOverDiff: () => [],
}));

it('evaluates worktree review as an ESM module', async () => {
  await expect(import('./worktree-review')).resolves.toMatchObject({
    parseWorktreeReviewMessage: expect.any(Function),
  });
});

it('passes the worktree review ESM domain regressions', () => {
  const result = spawnSync(
    process.execPath,
    [
      '--conditions=import',
      '--import',
      'tsx',
      '--test',
      join(__dirname, 'worktree-review.test.mts'),
    ],
    { timeout: 25_000, stdio: 'pipe', encoding: 'utf8' }
  );
  expect(result.error).toBeUndefined();
  expect({ status: result.status, output: result.stdout, error: result.stderr }).toEqual({
    status: 0,
    output: expect.any(String),
    error: '',
  });
}, 30_000);

it('keeps the shared review prompt cap equal to the cloud agent prompt cap', () => {
  // The shared module cannot import the SDK (the SDK builds on it), so the two
  // caps are declared separately. A review longer than the worker accepts would
  // only fail at the very end of the review, so assert the caps cannot drift.
  expect(MAX_WORKTREE_REVIEW_PROMPT_LENGTH).toBe(CLOUD_AGENT_PROMPT_MAX_LENGTH);
});
