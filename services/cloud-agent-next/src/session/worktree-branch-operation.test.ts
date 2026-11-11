import { describe, expect, it } from 'vitest';
import { CurrentSessionMetadataSchema } from '../persistence/session-metadata.js';
import { worktreeChangesContext } from '../sandbox-session/worktree-changes.js';
import {
  matchesExpectedWorktree,
  nextRepositoryBase,
  withRepositoryBase,
} from './worktree-branch-operation.js';

const current = { baseBranch: 'feat/parent', baseSha: 'a'.repeat(40) };
const newSha = 'b'.repeat(40);
const WORKTREE_ID = 'worktree_12345678-1234-4123-8123-123456789012';

function sessionFixture(sessionId: string) {
  return CurrentSessionMetadataSchema.parse({
    metadataSchemaVersion: 2,
    identity: { sessionId, userId: 'user_1', createdOnPlatform: 'cloud-agent-web' },
    auth: { kiloSessionId: 'ses_aaaaaaaaaaaaaaaaaaaaaaaaaa' },
    repository: {
      type: 'github',
      repo: 'acme/widgets',
      baseBranch: 'feat/old',
      baseSha: 'a'.repeat(40),
    },
    agent: {
      mode: 'code',
      model: 'kilo/test-model',
      appendSystemPrompt: 'Be concise.',
    },
    workspace: {
      worktreeId: WORKTREE_ID,
      branchName: 'kilo/stacked',
      sandboxId: `ses-${'0'.repeat(48)}`,
    },
    lifecycle: { version: 1, timestamp: 1 },
  });
}

describe('nextRepositoryBase', () => {
  it('adopts the effective base after syncing a branch retargeted by GitHub', () => {
    expect(
      nextRepositoryBase({
        current,
        result: { baseBranch: 'feat/somewhere-else', baseSha: newSha },
      })
    ).toEqual({ baseBranch: 'feat/somewhere-else', baseSha: newSha });
  });

  it('retargets both values for a restack result', () => {
    expect(
      nextRepositoryBase({
        current,
        result: { baseBranch: 'feat/new-parent', baseSha: newSha },
      })
    ).toEqual({ baseBranch: 'feat/new-parent', baseSha: newSha });
  });

  it('keeps the current values when a completed result has none', () => {
    expect(
      nextRepositoryBase({
        current,
        result: { baseBranch: null, baseSha: null },
      })
    ).toEqual(current);
  });
});

describe('withRepositoryBase', () => {
  it('adopts the base for a second session sharing the worktree', () => {
    const s1 = sessionFixture('ses_11111111111111111111111111');
    const s2 = sessionFixture('ses_22222222222222222222222222');
    // Both chats share one SandboxDO snapshot, but each carries a copy of the base.
    expect(s1.workspace?.worktreeId).toBe(s2.workspace?.worktreeId);
    expect(worktreeChangesContext(s1, '/worktree')?.baseRef).toBe('refs/remotes/origin/feat/old');
    expect(worktreeChangesContext(s2, '/worktree')?.baseRef).toBe('refs/remotes/origin/feat/old');

    const adopted = withRepositoryBase(s2, { baseBranch: 'main', baseSha: newSha });
    expect(adopted.repository).toMatchObject({ baseBranch: 'main', baseSha: newSha });
    expect(worktreeChangesContext(adopted, '/worktree')?.baseRef).toBe('refs/remotes/origin/main');
    expect(adopted.agent?.appendSystemPrompt).toContain('--base main');
    expect(adopted.agent?.appendSystemPrompt).not.toContain('--base feat/old');
    expect(adopted.agent?.appendSystemPrompt).toContain('Be concise.');
    expect(CurrentSessionMetadataSchema.safeParse(adopted).success).toBe(true);

    // Adoption is idempotent, and the un-adopted sibling keeps its old base.
    expect(withRepositoryBase(adopted, { baseBranch: 'main', baseSha: newSha })).toEqual(adopted);
    expect(s1.repository).toMatchObject({ baseBranch: 'feat/old' });
  });
});

describe('matchesExpectedWorktree', () => {
  it('requires the exact worktree, including rejecting a sibling or a missing id', () => {
    const metadata = sessionFixture('ses_11111111111111111111111111');
    expect(matchesExpectedWorktree(metadata, WORKTREE_ID)).toBe(true);
    expect(matchesExpectedWorktree(metadata, `${WORKTREE_ID}-other`)).toBe(false);
    expect(matchesExpectedWorktree(null, WORKTREE_ID)).toBe(false);
  });
});
