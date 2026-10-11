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
import { getWorktreeWorkspacePath } from '../../workspace';
import { router } from '../auth';
import { deleteWorktree } from './worktree-deletion';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getControl: vi.fn(),
  getDb: vi.fn(),
  diagnostic: vi.fn(),
}));
vi.mock('../../sandbox-control/diagnostics', () => ({ logControlDiagnostic: mocks.diagnostic }));
vi.mock('../../sandbox-session/session-stub', () => ({
  getSandboxSessionStub: mocks.getSession,
}));
vi.mock('../../sandbox-control/stub', () => ({
  getSandboxControlStub: mocks.getControl,
}));
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
      beginWorktreeDeletion: async () => ({
        location: await beginSession(id),
        children: await readChildren(),
      }),
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
  it.each([false, true])('reports aggregate phase timings when cleanup fails=%s', async fail => {
    const f = fixture(2);
    let now = 1000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    f.begin.mockImplementation(async () => {
      now += 10;
      return structuredClone(f.getState());
    });
    f.cleanup.mockImplementation(async input => {
      now += 25;
      if (fail) throw new Error('cleanup unavailable');
      return { deleted: true, sessionIds: input.sessionIds };
    });
    try {
      const pending = f.caller.deleteWorktree({ worktreeId });
      if (fail) await expect(pending).rejects.toThrow('Worktree deletion is incomplete');
      else await pending;
      const summaries = mocks.diagnostic.mock.calls.filter(
        ([event, fields]) => event === 'worktree_deletion' && fields.phase === 'finished'
      );
      expect(summaries).toHaveLength(1);
      expect(summaries[0][1]).toMatchObject({
        worktreeId,
        beginDeletionMs: 10,
        collectSessionsMs: 0,
        runtimeCleanupMs: 25,
        durationMs: 35,
        result: fail ? 'pending' : 'completed',
      });
      if (fail) expect(summaries[0][1]).not.toHaveProperty('completeDeletionMs');
      else expect(summaries[0][1]).toHaveProperty('completeDeletionMs', 0);
    } finally {
      clock.mockRestore();
    }
  });

  it.each(['begin', 'finish'] as const)(
    'bounds concurrent %s operations and waits before advancing phases',
    async phase => {
      const f = fixture(17, 2);
      const gates = Array.from({ length: 17 }, () => Promise.withResolvers<void>());
      let active = 0;
      let peak = 0;
      const operation = async (id: string) => {
        active += 1;
        peak = Math.max(peak, active);
        await gates.find((_, index) => workspaceId(index) === id)?.promise;
        active -= 1;
      };
      if (phase === 'begin') {
        f.beginSession.mockImplementation(async id => {
          await operation(id);
          return location;
        });
      } else {
        f.finishSession.mockImplementation(operation);
      }
      const pending = f.caller.deleteWorktree({ worktreeId });
      const calls = phase === 'begin' ? f.beginSession : f.finishSession;
      for (const start of [0, 8, 16]) {
        const end = Math.min(start + 8, 17);
        await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(end));
        expect(active).toBe(end - start);
        expect(f.complete).not.toHaveBeenCalled();
        if (phase === 'begin') {
          expect(f.record).not.toHaveBeenCalled();
          expect(f.cleanup).not.toHaveBeenCalled();
          expect(f.finishSession).not.toHaveBeenCalled();
        } else {
          expect(f.record).toHaveBeenCalledTimes(2);
          expect(f.cleanup).toHaveBeenCalledTimes(1);
        }
        for (const gate of gates.slice(start, end)) gate.resolve();
      }
      await expect(pending).resolves.toMatchObject({ success: true });
      expect(peak).toBe(8);
      expect(active).toBe(0);
    }
  );

  it.each(['begin', 'finish'] as const)(
    'drains started %s siblings on failure without starting another batch',
    async phase => {
      const f = fixture(17);
      const failed = Promise.withResolvers<void>();
      const siblings = Promise.withResolvers<void>();
      let settled = false;
      const operation = async (id: string) => {
        await (id === workspaceId(0) ? failed.promise : siblings.promise);
      };
      if (phase === 'begin') {
        f.beginSession.mockImplementation(async id => {
          await operation(id);
          return location;
        });
      } else {
        f.finishSession.mockImplementation(operation);
      }
      const pending = f.caller.deleteWorktree({ worktreeId }).catch(error => {
        settled = true;
        return error;
      });
      const calls = phase === 'begin' ? f.beginSession : f.finishSession;
      await vi.waitFor(() => expect(calls).toHaveBeenCalledTimes(8));
      failed.reject(new Error('deletion failed'));
      await failed.promise.catch(() => undefined);
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      expect(f.complete).not.toHaveBeenCalled();
      if (phase === 'begin') {
        expect(f.record).not.toHaveBeenCalled();
        expect(f.cleanup).not.toHaveBeenCalled();
        expect(f.finishSession).not.toHaveBeenCalled();
      }
      siblings.resolve();
      await expect(pending).resolves.toMatchObject({
        cause: { error: 'WORKTREE_DELETION_PENDING', retryable: true },
      });
      expect(calls).toHaveBeenCalledTimes(8);
      expect(f.complete).not.toHaveBeenCalled();
    }
  );

  it('records shared ingest manifests sequentially across both recording phases', async () => {
    const f = fixture(2);
    mocks.getSession.mockImplementation((_env, _ownerId, id: string) => ({
      beginWorktreeDeletion: async () => ({
        location: await f.beginSession(id),
        children: [{ sessionId: kiloId(2), parentSessionId: kiloId(0) }],
        directory: `/workspace/${id}`,
      }),
      finishWorktreeDeletion: () => f.finishSession(id),
    }));
    const record = f.record.getMockImplementation();
    if (!record) throw new Error('Missing record fixture');
    const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
    let active = 0;
    let peak = 0;
    let index = 0;
    f.record.mockImplementation(async input => {
      const gate = gates[index++];
      active += 1;
      peak = Math.max(peak, active);
      await gate.promise;
      const result = await record(input);
      active -= 1;
      return result;
    });
    const pending = f.caller.deleteWorktree({ worktreeId });
    for (let index = 0; index < gates.length; index++) {
      await vi.waitFor(() => expect(f.record).toHaveBeenCalledTimes(index + 1));
      expect(active).toBe(1);
      expect(f.finishSession).not.toHaveBeenCalled();
      expect(f.complete).not.toHaveBeenCalled();
      expect(f.cleanup).toHaveBeenCalledTimes(index < 2 ? 0 : 1);
      gates[index].resolve();
    }
    await expect(pending).resolves.toMatchObject({
      deletedSessionIds: [kiloId(0), kiloId(1), kiloId(2)],
    });
    expect(peak).toBe(1);
    expect(f.cleanup.mock.calls[0][0].sessionIds).toContain(kiloId(2));
  });

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

  it('records the stored checkout directory returned by the session DO', async () => {
    const f = fixture();
    const identity = getWorktreeWorkspacePath(organizationId, userId, worktreeId);
    mocks.getSession.mockImplementation((_env, ownerId: string, id: string) => {
      expect(ownerId).toBe(userId);
      return {
        beginWorktreeDeletion: async () => ({
          location: await f.beginSession(id),
          children: [],
          directory: '/workspace/app',
        }),
        finishWorktreeDeletion: () => f.finishSession(id),
      };
    });

    await expect(f.caller.deleteWorktree({ worktreeId })).resolves.toMatchObject({
      success: true,
    });
    expect(f.record.mock.calls.length).toBeGreaterThan(0);
    for (const call of f.record.mock.calls) {
      expect(call[0].directory).toBe('/workspace/app');
      expect(call[0].directory).not.toBe(identity);
    }
  });

  it('records every distinct stored checkout directory across sessions', async () => {
    const f = fixture(2);
    const identity = getWorktreeWorkspacePath(organizationId, userId, worktreeId);
    const directories = new Map<string, string>([
      [workspaceId(0), '/workspace/app'],
      [workspaceId(1), identity],
    ]);
    mocks.getSession.mockImplementation((_env, ownerId: string, id: string) => {
      expect(ownerId).toBe(userId);
      return {
        beginWorktreeDeletion: async () => ({
          location: await f.beginSession(id),
          children: [],
          directory: directories.get(id) ?? null,
        }),
        finishWorktreeDeletion: () => f.finishSession(id),
      };
    });

    await expect(f.caller.deleteWorktree({ worktreeId })).resolves.toMatchObject({
      success: true,
    });
    // Both call sites (record_manifest carrying runtimeLocations and
    // record_cleanup carrying sessionIds) must cover both directories.
    const manifestDirectories = new Set(
      f.record.mock.calls
        .filter(call => call[0].runtimeLocations !== undefined)
        .map(call => call[0].directory)
    );
    const cleanupDirectories = new Set(
      f.record.mock.calls
        .filter(call => call[0].sessionIds !== undefined)
        .map(call => call[0].directory)
    );
    expect(manifestDirectories).toEqual(new Set(['/workspace/app', identity]));
    expect(cleanupDirectories).toEqual(new Set(['/workspace/app', identity]));
  });

  it('falls back to the identity workspace path when no session returns a directory', async () => {
    const f = fixture();
    const identity = getWorktreeWorkspacePath(undefined, userId, worktreeId);

    await expect(f.caller.deleteWorktree({ worktreeId })).resolves.toMatchObject({
      success: true,
    });
    expect(f.record.mock.calls.length).toBeGreaterThan(0);
    for (const call of f.record.mock.calls) {
      expect(call[0].directory).toBe(identity);
    }
  });
});
