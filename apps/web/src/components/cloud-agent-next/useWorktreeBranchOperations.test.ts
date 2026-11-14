import { describe, expect, it, jest } from '@jest/globals';
import type {
  WorktreeBranchOperationResult as WorkerResult,
  WorktreeBranchOperationRefusalReason,
} from '@kilocode/worker-utils/cloud-agent-worktree-operations';
import {
  buildBranchConflictInstruction,
  dispatchWorktreeInstruction,
  orderRestackTargets,
  restackStackTargets,
  type WorktreeBranchOperationTarget,
} from './useWorktreeBranchOperations';

function target(
  worktreeId: string,
  overrides: Partial<WorktreeBranchOperationTarget> = {}
): WorktreeBranchOperationTarget {
  return {
    worktreeId,
    cloudAgentSessionId: `workspace_${worktreeId}`,
    branch: worktreeId,
    baseBranch: 'main',
    label: worktreeId,
    prNumber: null,
    prState: null,
    prUrl: null,
    stackNumber: null,
    stackPosition: null,
    isRoot: false,
    ...overrides,
  };
}

function result(
  operation: 'sync' | 'restack',
  overrides: Partial<WorkerResult> = {}
): WorkerResult {
  return {
    status: 'changed',
    operation,
    branch: 'feat/b',
    baseBranch: 'feat/a',
    baseSha: 'a'.repeat(40),
    previousRemoteSha: null,
    remoteSha: 'b'.repeat(40),
    headSha: 'c'.repeat(40),
    ...overrides,
  } as WorkerResult;
}

function refused(reason: WorktreeBranchOperationRefusalReason): WorkerResult {
  return {
    status: 'refused',
    operation: 'restack',
    branch: null,
    baseBranch: null,
    baseSha: null,
    previousRemoteSha: null,
    remoteSha: null,
    headSha: null,
    reason,
    message: 'The branch operation was refused.',
  };
}

const root = target('root', { isRoot: true, stackPosition: 0, baseBranch: 'main' });
const middle = target('middle', { stackPosition: 1, baseBranch: 'root' });
const top = target('top', { stackPosition: 2, baseBranch: 'middle' });

describe('orderRestackTargets', () => {
  it('keeps ancestry order, skips the root, and skips layers without a live session', () => {
    expect(
      orderRestackTargets([
        root,
        target('missing', { stackPosition: 1, cloudAgentSessionId: '' }),
        middle,
        top,
      ]).map(item => item.worktreeId)
    ).toEqual(['middle', 'top']);
  });
});

describe('restackStackTargets', () => {
  it('restacks the remaining layers bottom up', async () => {
    const calls: string[] = [];
    const outcome = await restackStackTargets([root, middle, top], async layer => {
      calls.push(layer.worktreeId);
      return result('restack');
    });

    expect(calls).toEqual(['middle', 'top']);
    expect(outcome.results.map(step => step.target.worktreeId)).toEqual(['middle', 'top']);
    expect(outcome.stopped).toBeNull();
  });

  it('stops on the first conflict so a child never rebases onto an unresolved parent', async () => {
    const calls: string[] = [];
    const conflict = {
      ...result('restack', { status: 'conflict' }),
      files: ['src/a.ts'],
      command: 'git rebase --onto feat/a abc',
      instruction: 'Resolve src/a.ts.',
    } as WorkerResult;
    const outcome = await restackStackTargets([root, middle, top], async layer => {
      calls.push(layer.worktreeId);
      return conflict;
    });

    expect(calls).toEqual(['middle']);
    expect(outcome.results).toEqual([{ target: middle, result: conflict }]);
    expect(outcome.stopped?.target.worktreeId).toBe('middle');
  });

  it('stops on a refusal without restacking later layers', async () => {
    const calls: string[] = [];
    const outcome = await restackStackTargets([root, middle, top], async layer => {
      calls.push(layer.worktreeId);
      return refused('turn_running');
    });

    expect(calls).toEqual(['middle']);
    expect(outcome.stopped?.result.status).toBe('refused');
    expect(outcome.stopped?.target.worktreeId).toBe('middle');
  });

  it('retries the same layer once when a restack only synced, then continues', async () => {
    const calls: string[] = [];
    const outcome = await restackStackTargets([root, middle, top], async layer => {
      calls.push(layer.worktreeId);
      if (layer.worktreeId === 'middle' && calls.filter(id => id === 'middle').length === 1) {
        return result('sync');
      }
      return result('restack');
    });

    expect(calls).toEqual(['middle', 'middle', 'top']);
    expect(outcome.results.map(step => step.result.operation)).toEqual(['restack', 'restack']);
    expect(outcome.stopped).toBeNull();
  });

  it('stops when the retried restack still only syncs and never advances children', async () => {
    const calls: string[] = [];
    const outcome = await restackStackTargets([root, middle, top], async layer => {
      calls.push(layer.worktreeId);
      return result('sync');
    });

    expect(calls).toEqual(['middle', 'middle']);
    expect(outcome.results).toEqual([]);
    expect(outcome.stopped?.target.worktreeId).toBe('middle');
    expect(outcome.stopped?.result.operation).toBe('sync');
  });
});

describe('dispatchWorktreeInstruction', () => {
  it('respects a false callback for the current target without falling back to a raw resend', async () => {
    const send = jest.fn<(instruction: string) => Promise<boolean>>(async () => false);
    const getSession = jest.fn();
    const sendMessage = jest.fn();
    const trpcClient = {
      cloudAgentNext: {
        getSession: { query: getSession },
        sendMessage: { mutate: sendMessage },
      },
      organizations: {
        cloudAgentNext: {
          getSession: { query: jest.fn() },
          sendMessage: { mutate: jest.fn() },
        },
      },
    } as unknown as Parameters<typeof dispatchWorktreeInstruction>[0]['trpcClient'];

    const outcome = await dispatchWorktreeInstruction({
      trpcClient,
      onSendInstruction: send,
      currentCloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000001',
      target: {
        worktreeId: 'worktree_00000000-0000-4000-8000-000000000001',
        cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000001',
      },
      instruction: 'Resolve the conflict.',
    });

    expect(outcome).toBe('manual');
    expect(send).toHaveBeenCalledWith('Resolve the conflict.');
    expect(getSession).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('sends an org-scoped instruction to another layer using its stored model and mode', async () => {
    const getSession = jest.fn<
      (input: { organizationId: string; cloudAgentSessionId: string }) => Promise<{
        userId: string;
        model: string;
        mode: string;
      }>
    >(async () => ({
      userId: 'user_1',
      model: 'anthropic/claude',
      mode: 'code',
    }));
    const sendMessage = jest.fn<(input: Record<string, unknown>) => Promise<unknown>>(
      async () => ({})
    );
    const trpcClient = {
      cloudAgentNext: {
        getSession: { query: jest.fn() },
        sendMessage: { mutate: jest.fn() },
      },
      organizations: {
        cloudAgentNext: {
          getSession: { query: getSession },
          sendMessage: { mutate: sendMessage },
        },
      },
    } as unknown as Parameters<typeof dispatchWorktreeInstruction>[0]['trpcClient'];

    const outcome = await dispatchWorktreeInstruction({
      trpcClient,
      organizationId: 'org_1',
      currentCloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000001',
      target: {
        worktreeId: 'worktree_00000000-0000-4000-8000-000000000002',
        cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000002',
      },
      instruction: 'Resolve the conflict.',
    });

    expect(outcome).toBe('sent');
    expect(getSession).toHaveBeenCalledWith({
      organizationId: 'org_1',
      cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000002',
    });
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: 'org_1',
        cloudAgentSessionId: 'workspace_00000000-0000-4000-8000-000000000002',
        expectedWorktreeId: 'worktree_00000000-0000-4000-8000-000000000002',
        messageId: expect.stringMatching(/^msg_/),
        payload: {
          type: 'prompt',
          prompt: 'Resolve the conflict.',
          mode: 'code',
          model: 'anthropic/claude',
        },
      })
    );
  });
});

describe('buildBranchConflictInstruction', () => {
  it('uses the wrapper instruction verbatim so the agent gets the exact aborted command', () => {
    const conflict = {
      status: 'conflict',
      operation: 'restack',
      branch: 'feat/b',
      baseBranch: 'feat/a',
      baseSha: 'a'.repeat(40),
      previousRemoteSha: null,
      remoteSha: null,
      headSha: 'b'.repeat(40),
      files: ['src/a.ts'],
      command: 'git rebase --onto feat/a abc',
      instruction: 'Resolve src/a.ts, run tests, push --force-with-lease.',
    } satisfies WorkerResult;
    expect(
      buildBranchConflictInstruction(
        { label: 'Child', branch: 'feat/b', baseBranch: 'feat/a' },
        conflict
      )
    ).toBe('Resolve src/a.ts, run tests, push --force-with-lease.');
  });
});
