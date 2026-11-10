import { describe, expect, it } from 'vitest';
import {
  worktreeBranchOperationRequestSchema,
  worktreeBranchOperationResultSchema,
} from './cloud-agent-worktree-operations.js';

const head = 'a'.repeat(40);
const remote = 'b'.repeat(40);
const base = 'c'.repeat(40);

function common(status: 'changed' | 'unchanged') {
  return {
    status,
    operation: 'restack' as const,
    branch: 'feature',
    baseBranch: 'main',
    baseSha: base,
    previousRemoteSha: remote,
    remoteSha: remote,
    headSha: head,
  };
}

describe('worktree branch operation contract', () => {
  it('validates a strict request', () => {
    expect(worktreeBranchOperationRequestSchema.parse({ operation: 'sync' })).toEqual({
      operation: 'sync',
    });
    expect(
      worktreeBranchOperationRequestSchema.parse({
        operation: 'restack',
        baseBranch: 'main',
        upstreamSha: head,
      })
    ).toMatchObject({ operation: 'restack' });
    expect(
      worktreeBranchOperationRequestSchema.safeParse({ operation: 'sync', extra: true }).success
    ).toBe(false);
  });

  it('accepts changed and unchanged results', () => {
    expect(worktreeBranchOperationResultSchema.parse(common('changed'))).toMatchObject({
      status: 'changed',
    });
    expect(worktreeBranchOperationResultSchema.parse(common('unchanged'))).toMatchObject({
      status: 'unchanged',
    });
  });

  it('requires conflict evidence', () => {
    const conflict = {
      ...common('changed'),
      status: 'conflict',
      files: ['src/a.ts'],
      command: 'git rebase --onto origin/main abc',
      instruction: 'Resolve and push',
    };
    expect(worktreeBranchOperationResultSchema.parse(conflict)).toMatchObject({
      status: 'conflict',
      files: ['src/a.ts'],
    });
    expect(
      worktreeBranchOperationResultSchema.safeParse({ ...conflict, files: undefined }).success
    ).toBe(false);
  });

  it('lets a pre-call refusal omit branch and HEAD', () => {
    expect(
      worktreeBranchOperationResultSchema.parse({
        status: 'refused',
        operation: 'restack',
        branch: null,
        baseBranch: null,
        baseSha: null,
        previousRemoteSha: null,
        remoteSha: null,
        headSha: null,
        reason: 'branch_owned_by_sibling',
        message: 'Another workspace owns this branch',
      })
    ).toMatchObject({ status: 'refused', headSha: null });
  });

  it('rejects an unknown refusal reason and missing common fields', () => {
    expect(
      worktreeBranchOperationResultSchema.safeParse({
        ...common('changed'),
        status: 'refused',
        reason: 'made_up',
        message: 'no',
      }).success
    ).toBe(false);
    expect(
      worktreeBranchOperationResultSchema.safeParse({ ...common('changed'), headSha: undefined })
        .success
    ).toBe(false);
  });
});
