import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type {
  CloudAgentWorktreeDeletionState,
  CloudAgentWorktreeDeletionParams,
  CloudAgentChildSessionLineage,
  RecordCloudAgentWorktreeCleanupParams,
} from '@kilocode/session-ingest-contracts';
import type { TRPCContext } from '../../types';
import { router } from '../auth';
import { deleteWorktree } from './worktree-deletion';

const mocks = vi.hoisted(() => ({ getSession: vi.fn(), getControl: vi.fn(), getDb: vi.fn() }));
vi.mock('../../sandbox-session/session-stub', () => ({ getSandboxSessionStub: mocks.getSession }));
vi.mock('../../sandbox-control/stub', () => ({ getSandboxControlStub: mocks.getControl }));
vi.mock('../../db/pg', () => ({ getPgDb: mocks.getDb }));

const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const userId = 'oauth/google:worktree-owner';
const location = { sandboxId: 'usr-original-route', provider: 'cloudflare' as const };
const kiloId = (index: number) => `ses_${String(index).padStart(26, '0')}`;
const workspaceId = (index: number): `workspace_${string}` =>
  `workspace_${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`;

function fixture(rootCount = 1, childCount = 0) {
  let state: CloudAgentWorktreeDeletionState = {
    completed: false,
    manifest: {
      version: 1,
      sessions: [
        ...Array.from({ length: rootCount }, (_, index) => ({
          sessionId: kiloId(index),
          cloudAgentSessionId: workspaceId(index),
        })),
        ...Array.from({ length: childCount }, (_, index) => ({
          sessionId: kiloId(rootCount + index),
          cloudAgentSessionId: null,
        })),
      ],
    },
    runtimeLocations: [],
  };
  const finished = new Set<string>();
  const readChildren = vi.fn<() => Promise<CloudAgentChildSessionLineage[]>>(async () => []);
  const beginSession = vi.fn(async (sessionId: string) =>
    finished.has(sessionId) ? null : location
  );
  const finishSession = vi.fn(async (sessionId: string) => {
    finished.add(sessionId);
  });
  mocks.getSession.mockImplementation((_env, ownerId: string, id: string) => {
    expect(ownerId).toBe(userId);
    return {
      beginWorktreeDeletion: () => beginSession(id),
      getWorktreeChildSessions: readChildren,
      finishWorktreeDeletion: () => finishSession(id),
    };
  });
  const cleanup = vi.fn(async (input: { sessionIds: string[] }) => ({
    deleted: true,
    sessionIds: input.sessionIds,
  }));
  mocks.getControl.mockReturnValue({ deleteWorktreeResources: cleanup });
  const begin = vi.fn(async (_params: CloudAgentWorktreeDeletionParams) => structuredClone(state));
  const record = vi.fn(async (input: RecordCloudAgentWorktreeCleanupParams) => {
    state.runtimeLocations = input.runtimeLocations ?? state.runtimeLocations;
    for (const sessionId of [
      ...(input.sessionIds ?? []),
      ...(input.childSessions ?? []).map(child => child.sessionId),
    ]) {
      if (!state.manifest.sessions.some(session => session.sessionId === sessionId)) {
        state.manifest.sessions.push({ sessionId, cloudAgentSessionId: null });
      }
    }
    return structuredClone(state);
  });
  const complete = vi.fn(async () => {
    state = { ...state, completed: true };
    return {
      success: true,
      deletedSessionIds: state.manifest.sessions.map(session => session.sessionId),
    };
  });
  let membershipCondition: SQL | undefined;
  let membershipJoin: SQL | undefined;
  const membership = vi.fn(async () => [{ id: 'membership' }]);
  const query = {
    from: () => query,
    innerJoin: (_table: unknown, condition: SQL) => {
      membershipJoin = condition;
      return query;
    },
    where: (condition: SQL) => {
      membershipCondition = condition;
      return query;
    },
    limit: membership,
  };
  mocks.getDb.mockReturnValue({ select: () => query });
  const ctx: TRPCContext = {
    userId,
    authToken: 'test-auth',
    request: new Request('https://worker.test/trpc/deleteWorktree', {
      headers: { 'x-skip-balance-check': 'true' },
    }),
    env: {
      SESSION_INGEST: {
        beginCloudAgentWorktreeDeletion: begin,
        recordCloudAgentWorktreeCleanup: record,
        completeCloudAgentWorktreeDeletion: complete,
      },
    } as never,
  };
  return {
    caller: router({ deleteWorktree }).createCaller(ctx),
    ctx,
    begin,
    record,
    complete,
    cleanup,
    beginSession,
    readChildren,
    finishSession,
    membership,
    getState: () => state,
    membershipSql: () =>
      membershipCondition ? new PgDialect().sqlToQuery(membershipCondition) : undefined,
    membershipJoinSql: () =>
      membershipJoin ? new PgDialect().sqlToQuery(membershipJoin).sql : undefined,
  };
}

beforeEach(() => vi.resetAllMocks());

describe('deleteWorktree authorization and completion', () => {
  it('journals retained child lineage before cold runtime cleanup and keeps it on retry', async () => {
    const f = fixture();
    f.readChildren.mockResolvedValue([{ sessionId: kiloId(1), parentSessionId: kiloId(0) }]);
    f.cleanup.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(f.caller.deleteWorktree({ worktreeId })).rejects.toMatchObject({
      cause: { error: 'WORKTREE_DELETION_PENDING' },
    });
    expect(f.record.mock.calls[0][0].childSessions).toEqual([
      { sessionId: kiloId(1), parentSessionId: kiloId(0), cloudAgentSessionId: workspaceId(0) },
    ]);
    expect(f.getState().manifest.sessions.map(session => session.sessionId)).toEqual([
      kiloId(0),
      kiloId(1),
    ]);
    f.readChildren.mockResolvedValue([]);
    await expect(f.caller.deleteWorktree({ worktreeId })).resolves.toEqual({
      success: true,
      deletedSessionIds: [kiloId(0), kiloId(1)],
    });
  });

  it('deletes and retries an ownership-only root using the canonical allocation returned by ingest', async () => {
    const f = fixture();
    f.getState().runtimeLocations = [location];
    f.beginSession.mockResolvedValue(null);
    f.cleanup.mockRejectedValueOnce(new Error('provider temporarily unavailable'));
    await expect(f.caller.deleteWorktree({ worktreeId })).rejects.toMatchObject({
      cause: { error: 'WORKTREE_DELETION_PENDING', retryable: true },
    });
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.getState().runtimeLocations).toEqual([location]);
    await expect(f.caller.deleteWorktree({ worktreeId })).resolves.toEqual({
      success: true,
      deletedSessionIds: [kiloId(0)],
    });
    expect(mocks.getControl).toHaveBeenCalledWith(f.ctx.env, location.sandboxId);
  });

  it('isolates unavailable allocation history instead of repeatedly waiting for registration that is fenced', async () => {
    const f = fixture();
    f.beginSession.mockResolvedValue(null);
    await expect(f.caller.deleteWorktree({ worktreeId })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      cause: { error: 'WORKTREE_RUNTIME_HISTORY_UNAVAILABLE', retryable: false },
    });
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.getState().manifest.sessions).toHaveLength(1);
  });

  it('uses only the authenticated text owner and interprets omitted organization as personal', async () => {
    const f = fixture();
    await expect(f.caller.deleteWorktree({ worktreeId })).resolves.toEqual({
      success: true,
      deletedSessionIds: [kiloId(0)],
    });
    expect(f.begin).toHaveBeenCalledWith({ worktreeId, kiloUserId: userId });
    expect(mocks.getDb).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated request and a client-supplied owner', async () => {
    const f = fixture();
    const anonymous = router({ deleteWorktree }).createCaller({ ...f.ctx, userId: '' });
    await expect(anonymous.deleteWorktree({ worktreeId })).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
    await expect(
      f.caller.deleteWorktree({ worktreeId, kiloUserId: 'attacker' } as never)
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(f.begin).not.toHaveBeenCalled();
  });

  it('denies a wrong owner or exact-scope mismatch without touching runtime resources', async () => {
    const f = fixture();
    f.begin.mockRejectedValue(new Error('worktree_access_denied'));
    await expect(f.caller.deleteWorktree({ worktreeId })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    expect(f.cleanup).not.toHaveBeenCalled();
    expect(f.beginSession).not.toHaveBeenCalled();
  });

  it('requires current non-deleted organization membership even when balance checks are skipped', async () => {
    const f = fixture();
    f.membership.mockResolvedValue([]);
    await expect(
      f.caller.deleteWorktree({ worktreeId, kilocodeOrganizationId: organizationId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(f.begin).not.toHaveBeenCalled();
    expect(f.membershipSql()?.params).toEqual(expect.arrayContaining([userId, organizationId]));
    expect(f.membershipJoinSql()).toContain('"deleted_at" is null');
  });

  it('cleans every root, including unopened roots beyond 200, and returns all descendants', async () => {
    const f = fixture(205, 15);
    const result = await f.caller.deleteWorktree({ worktreeId });
    expect(result.deletedSessionIds).toHaveLength(220);
    expect(new Set(result.deletedSessionIds).size).toBe(220);
    expect(f.beginSession).toHaveBeenCalledTimes(205);
    expect(f.finishSession).toHaveBeenCalledTimes(205);
    expect(f.cleanup.mock.calls[0][0].sessionIds).toHaveLength(220);
    expect(f.complete.mock.invocationCallOrder[0]).toBeGreaterThan(
      f.finishSession.mock.invocationCallOrder.at(-1) ?? 0
    );
  });

  it('keeps discovery and reports a retryable error after partial runtime failure', async () => {
    const f = fixture(2, 2);
    f.cleanup.mockRejectedValueOnce(new Error('wrapper disconnected'));
    await expect(f.caller.deleteWorktree({ worktreeId })).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      cause: { retryable: true, error: 'WORKTREE_DELETION_PENDING' },
    });
    expect(f.finishSession).not.toHaveBeenCalled();
    expect(f.complete).not.toHaveBeenCalled();
    expect(f.getState().runtimeLocations).toEqual([location]);
    await expect(f.caller.deleteWorktree({ worktreeId })).resolves.toMatchObject({
      success: true,
      deletedSessionIds: [kiloId(0), kiloId(1), kiloId(2), kiloId(3)],
    });
  });

  it('can retry ingest cleanup after session metadata has already been erased', async () => {
    const f = fixture(1, 1);
    f.complete.mockRejectedValueOnce(new Error('R2 unavailable'));
    await expect(f.caller.deleteWorktree({ worktreeId })).rejects.toMatchObject({
      cause: { retryable: true },
    });
    await expect(f.caller.deleteWorktree({ worktreeId })).resolves.toEqual({
      success: true,
      deletedSessionIds: [kiloId(0), kiloId(1)],
    });
    expect(f.getState().completed).toBe(true);
  });

  it('authorizes completed tombstones on retry without requiring surviving session rows', async () => {
    const f = fixture();
    await f.caller.deleteWorktree({ worktreeId, kilocodeOrganizationId: organizationId });
    const cleanupCalls = f.cleanup.mock.calls.length;
    await expect(
      f.caller.deleteWorktree({ worktreeId, kilocodeOrganizationId: organizationId })
    ).resolves.toMatchObject({ success: true });
    expect(f.cleanup).toHaveBeenCalledTimes(cleanupCalls);
    f.membership.mockResolvedValue([]);
    await expect(
      f.caller.deleteWorktree({ worktreeId, kilocodeOrganizationId: organizationId })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
