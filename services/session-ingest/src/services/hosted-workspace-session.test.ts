import type { WorkerDb } from '@kilocode/db/client';
import { describe, expect, it, vi } from 'vitest';

import {
  assertHostedWorkspaceSessionDeletable,
  deleteHostedWorkspaceSessionRows,
} from './hosted-workspace-session';

const workspaceId = 'worktree_11111111-1111-4111-8111-111111111111';
const cloudAgentSessionId = 'workspace_11111111-1111-4111-8111-111111111111';
const kiloSessionId = 'ses_11111111111111111111111111';
const siblingSessionId = 'ses_22222222222222222222222222';

const target = {
  session_id: kiloSessionId,
  cloud_agent_session_id: cloudAgentSessionId,
  cloud_agent_worktree_id: workspaceId,
  parent_session_id: null,
};

function selectBuilder(value: unknown[]) {
  return {
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(() => Promise.resolve(value)),
      })),
    })),
  };
}

function lockedSelectBuilder(value: unknown[], lock: () => void, ordered: boolean) {
  const lockResult = { for: vi.fn(() => (lock(), Promise.resolve(value))) };
  return {
    from: vi.fn(() => ({
      where: vi.fn(() =>
        ordered ? { orderBy: vi.fn(() => lockResult) } : { limit: vi.fn(() => lockResult) }
      ),
    })),
  };
}

function createDb(options: { deleteRows: boolean }) {
  const locks: string[] = [];
  const builders = [
    selectBuilder([target]),
    lockedSelectBuilder([{ deletionStartedAt: null }], () => locks.push('worktree'), false),
    lockedSelectBuilder(
      [
        {
          sessionId: kiloSessionId,
          cloudAgentSessionId,
          worktreeId: workspaceId,
          parentSessionId: null,
        },
        {
          sessionId: siblingSessionId,
          cloudAgentSessionId: 'workspace_22222222-2222-4222-8222-222222222222',
          worktreeId: workspaceId,
          parentSessionId: null,
        },
      ],
      () => locks.push('roots'),
      true
    ),
    selectBuilder([
      {
        session_id: kiloSessionId,
        parent_session_id: null,
        organization_id: null,
        git_url: null,
        git_branch: null,
        created_on_platform: 'agent-manager',
      },
    ]),
  ];
  let selectIndex = 0;
  const tx = {
    select: vi.fn(() => builders[selectIndex++]),
    execute: vi.fn(() => Promise.resolve({ rows: [{ session_id: kiloSessionId, depth: 0 }] })),
    delete: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })),
  };
  const db = {
    transaction: vi.fn(async callback => callback(tx)),
  } as unknown as WorkerDb;

  if (!options.deleteRows) builders.splice(3);
  return { db, locks };
}

describe('hosted workspace session delete lock order', () => {
  it('checks deletability by locking worktree then roots', async () => {
    const { db, locks } = createDb({ deleteRows: false });

    await expect(
      assertHostedWorkspaceSessionDeletable(db, {
        kiloUserId: 'oauth/lock-order',
        sessionId: kiloSessionId,
        cloudAgentSessionId,
      })
    ).resolves.toEqual({ workspaceId });

    expect(locks).toEqual(['worktree', 'roots']);
  });

  it('deletes rows after locking worktree then roots', async () => {
    const { db, locks } = createDb({ deleteRows: true });

    await expect(
      deleteHostedWorkspaceSessionRows(db, {
        kiloUserId: 'oauth/lock-order',
        workspaceId,
        sessionId: kiloSessionId,
        cloudAgentSessionId,
      })
    ).resolves.toMatchObject({ deleted: true, deletedSessionIds: [kiloSessionId] });

    expect(locks).toEqual(['worktree', 'roots']);
  });
});
