import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  cli_sessions_v2,
  cloud_agent_pr_watch_activity,
  cloud_agent_pr_watches,
  cloud_agent_worktrees,
  organization_memberships,
  operation_ledgers,
  type CloudAgentWorktree,
  type CloudAgentPrWatch,
} from '@kilocode/db/schema';
import {
  cloudAgentWorktreeDeletionManifestSchema,
  cloudAgentWorktreeDeletionSchema,
  WORKTREE_MEMBERSHIP_CHANGED,
  type CloudAgentWorktreeDeletionParams,
  type CanDestroyCloudAgentWorktreeSandboxParams,
} from '@kilocode/session-ingest-contracts';
import {
  beginWorktreeDeletion,
  recordWorktreeCleanup,
  completeWorktreeDeletion,
  deleteWorktreeContent,
  canDestroyWorktreeSandbox,
  registerCloudAgentWorktree,
  retireWorktreeIfSoleMember,
} from './worktree-deletion';
import type { Env } from '../env';
import type { SessionEventPayload } from '../types/user-connection-protocol';

const mocks = vi.hoisted(() => ({
  getDb: vi.fn(),
  ingest: vi.fn(),
  cache: vi.fn(),
  connection: vi.fn(),
}));
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
vi.mock('@kilocode/db/client', () => ({ getWorkerDb: mocks.getDb }));
vi.mock('../dos/SessionIngestDO', () => ({ getSessionIngestDO: mocks.ingest }));
vi.mock('../dos/SessionAccessCacheDO', () => ({ getSessionAccessCacheDO: mocks.cache }));
vi.mock('../dos/UserConnectionDO', () => ({ getUserConnectionDO: mocks.connection }));

const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const otherWorktreeId = 'worktree_22222222-2222-4222-8222-222222222222';
const organizationId = '33333333-3333-4333-8333-333333333333';
const userId = 'oauth/github:worktree-owner';
const location = { sandboxId: 'ses-original', provider: 'cloudflare' as const };
const createdAt = '2026-08-27 01:00:00+00';
const params = { worktreeId, kiloUserId: userId } satisfies CloudAgentWorktreeDeletionParams;
const env = { HYPERDRIVE: { connectionString: 'postgres://unused' } } as Env;
const kiloId = (index: number) => `ses_${String(index).padStart(26, '0')}`;
const cloudId = (index: number): `workspace_${string}` =>
  `workspace_${String(index).padStart(8, '0')}-0000-4000-8000-000000000000`;

function worktree(values: Partial<CloudAgentWorktree> = {}): CloudAgentWorktree {
  return {
    worktree_id: worktreeId,
    kilo_user_id: userId,
    organization_id: null,
    name: 'Private worktree name',
    folder_id: null,
    created_at: createdAt,
    updated_at: '2026-08-27 01:00:00+00',
    deletion_started_at: null,
    deletion_completed_at: null,
    runtime_locations: [location],
    deletion_manifest: null,
    deleted_session_ids: [],
    ...values,
  };
}

describe('watch settlement at the deletion fence', () => {
  it.each([null, organizationId])(
    'finishes only associated live watches atomically for tenant %s',
    async tenant => {
      const f = database();
      f.worktrees[0].organization_id = tenant;
      f.members[0].organizationId = tenant;
      const source = {
        id: 'watch-source',
        worktree_id: worktreeId,
        kilo_user_id: userId,
        organization_id: tenant,
        status: 'watching' as const,
        generation: 4,
        lifecycle_reason: null,
        projection: { pending: [{ key: 'failure' }], needsAttention: true },
      };
      f.watches.push(
        source,
        { ...source, id: 'paused', status: 'paused' },
        { ...source, id: 'other-worktree', worktree_id: otherWorktreeId },
        { ...source, id: 'other-owner', kilo_user_id: 'other-owner' },
        { ...source, id: 'other-tenant', organization_id: tenant ? null : organizationId },
        { ...source, id: 'finished', status: 'finished' }
      );
      const untouched = structuredClone(f.watches.slice(2));
      const input = { ...params, ...(tenant ? { organizationId: tenant } : {}) };
      await beginWorktreeDeletion(env, input);
      expect(f.watches.slice(0, 2)).toEqual([
        expect.objectContaining({
          id: 'watch-source',
          generation: 5,
          status: 'finished',
          lifecycle_reason: 'source_worktree_deleted',
          projection: { pending: [], needsAttention: false },
        }),
        expect.objectContaining({
          id: 'paused',
          generation: 5,
          status: 'finished',
          lifecycle_reason: 'source_worktree_deleted',
          projection: { pending: [], needsAttention: false },
        }),
      ]);
      expect(f.watches.slice(2)).toEqual(untouched);
      expect(f.watchActivity).toEqual(
        ['watch-source', 'paused'].map(watch_id => ({
          watch_id,
          generation: 5,
          kind: 'finished',
          reason: 'source_worktree_deleted',
        }))
      );
      const update = f.watchUpdates[0];
      const dialect = new PgDialect();
      const query = dialect.sqlToQuery(update.condition);
      expect(query.params).toEqual([worktreeId, userId, ...(tenant ? [tenant] : [])]);
      expect(query.sql).toContain('"status" != \'finished\'');
      expect(query.sql).toContain(tenant ? '"organization_id" =' : '"organization_id" is null');
      expect(dialect.sqlToQuery(update.values.generation as SQL).sql).toContain('"generation" + 1');
      expect(dialect.sqlToQuery(update.values.projection as SQL).sql).toContain(
        "'{pending}', '[]'::jsonb"
      );
      expect(dialect.sqlToQuery(update.values.projection as SQL).sql).toContain(
        "'{needsAttention}', 'false'::jsonb"
      );
      expect(f.events.indexOf('lockWorktree')).toBeLessThan(f.events.indexOf('finishWatches'));
      expect(f.events.indexOf('updateWorktree')).toBeLessThan(f.events.indexOf('finishWatches'));
      expect(f.events.indexOf('watchActivity')).toBeLessThan(f.events.indexOf('commit'));
      await beginWorktreeDeletion(env, input);
      expect(f.watchActivity).toHaveLength(2);
      expect(f.watches[0].generation).toBe(5);
    }
  );

  it('rolls back both the deletion manifest and watch settlement when commit fails', async () => {
    const f = database();
    f.watches.push({
      id: 'watch',
      worktree_id: worktreeId,
      kilo_user_id: userId,
      organization_id: null,
      status: 'watching',
      generation: 1,
      lifecycle_reason: null,
      projection: { pending: [{ key: 'failure' }], needsAttention: true },
    });
    const before = structuredClone(f.watches);
    f.failCommit(new Error('commit failed'));
    await expect(beginWorktreeDeletion(env, params)).rejects.toThrow('commit failed');
    expect(f.worktrees[0].deletion_started_at).toBeNull();
    expect(f.worktrees[0].deletion_manifest).toBeNull();
    expect(f.watches).toEqual(before);
    expect(f.watchActivity).toEqual([]);
    f.failCommit();
    await beginWorktreeDeletion(env, params);
    expect(f.watches[0]).toMatchObject({ status: 'finished', generation: 2 });
    expect(f.watchActivity).toHaveLength(1);
  });
});

type Member = {
  sessionId: string;
  cloudAgentSessionId: string | null;
  cloudAgentSessionScopeId?: string | null;
  organizationId: string | null;
  worktreeId: string | null;
  userId: string;
  parentSessionId: string | null;
  createdAt?: string;
  gitUrl?: string;
  gitBranch?: string;
  createdOnPlatform?: string;
};

function database(rootCount = 1, descendantCount = 0) {
  const worktrees: CloudAgentWorktree[] = [worktree()];
  const watches: Pick<
    CloudAgentPrWatch,
    | 'id'
    | 'worktree_id'
    | 'kilo_user_id'
    | 'organization_id'
    | 'status'
    | 'generation'
    | 'lifecycle_reason'
    | 'projection'
  >[] = [];
  const watchActivity: (typeof cloud_agent_pr_watch_activity.$inferInsert)[] = [];
  const watchUpdates: { condition: SQL; values: Record<string, unknown> }[] = [];
  const members: Member[] = [
    ...Array.from({ length: rootCount }, (_, index) => ({
      sessionId: kiloId(index),
      cloudAgentSessionId: cloudId(index),
      organizationId: null,
      worktreeId,
      userId,
      parentSessionId: null,
    })),
    ...Array.from({ length: descendantCount }, (_, index) => ({
      sessionId: kiloId(rootCount + index),
      cloudAgentSessionId: null,
      cloudAgentSessionScopeId: cloudId(0),
      organizationId: null,
      worktreeId,
      userId,
      parentSessionId: kiloId(index === 0 ? 0 : rootCount + index - 1),
    })),
  ];
  const allocations: Array<{
    kilo_user_id: string;
    organization_id: string | null;
    intent: string;
    resource_key: string | null;
    canonical_result: Record<string, unknown>;
  }> = [];
  const events: string[] = [];
  const sqlQueries: { sql: string; params: unknown[] }[] = [];
  const childQueries: { sql: string; params: unknown[] }[] = [];
  const candidateQueries: { sql: string; params: unknown[] }[] = [];
  const ownershipUpdates: unknown[] = [];
  const ledgerReads: unknown[] = [];
  let membershipAllowed = true;
  let inTransaction = false;
  let transactionWrote = false;
  let frozenWorktreeReads: CloudAgentWorktree[] | undefined;
  const valuesOf = (condition: SQL | undefined) =>
    condition ? new PgDialect().sqlToQuery(condition).params : [];
  const select = (columns?: Record<string, unknown>) => {
    let table: unknown;
    let condition: SQL | undefined;
    const rows = () => {
      const bound = valuesOf(condition);
      if (table === cloud_agent_worktrees) {
        const source = !inTransaction && frozenWorktreeReads ? frozenWorktreeReads : worktrees;
        const id = bound.find(value => typeof value === 'string' && value.startsWith('worktree_'));
        return id
          ? source.filter(row => row.worktree_id === id)
          : source.filter(row => row.deletion_completed_at === null);
      }
      if (table === organization_memberships)
        return membershipAllowed ? [{ id: 'membership' }] : [];
      if (table === operation_ledgers) {
        ledgerReads.push(bound);
        return allocations;
      }
      if (table === cli_sessions_v2) {
        const querySql = condition ? new PgDialect().sqlToQuery(condition).sql : '';
        if (querySql.includes('"parent_session_id" in')) {
          childQueries.push({ sql: querySql, params: bound });
          const ids = bound.slice(1, 1 + (bound.length - 1) / 2);
          return members
            .filter(
              row =>
                row.userId === bound[0] &&
                ids.includes(row.parentSessionId) &&
                !ids.includes(row.sessionId)
            )
            .slice(0, 1);
        }
        if (querySql.includes('"cloud_agent_session_id" is null')) {
          candidateQueries.push({ sql: querySql, params: bound });
          throw new Error('Unscoped candidate queries are forbidden');
        }
        if (
          columns &&
          'worktreeId' in columns &&
          !bound.some(value => typeof value === 'string' && value.startsWith('ses_'))
        )
          return members.filter(
            row =>
              (!querySql.includes('"kilo_user_id"') || bound.includes(row.userId)) &&
              row.parentSessionId === null &&
              row.cloudAgentSessionId !== null
          );
        return members.filter(
          row =>
            (!querySql.includes('"kilo_user_id"') || bound.includes(row.userId)) &&
            (bound.includes(row.sessionId) ||
              (bound.includes(worktreeId) && row.worktreeId === worktreeId))
        );
      }
      throw new Error('Unexpected table');
    };
    const query = {
      from: (value: unknown) => {
        table = value;
        return query;
      },
      innerJoin: () => query,
      where: (value: SQL) => {
        condition = value;
        return query;
      },
      orderBy: () => query,
      limit: () => query,
      for: async () => {
        events.push(table === cloud_agent_worktrees ? 'lockWorktree' : 'lockRoots');
        return rows();
      },
      then: (resolve: (result: unknown[]) => unknown) => resolve(rows()),
    };
    return query;
  };
  const insert = (table: unknown) => ({
    values: (
      values:
        | typeof cloud_agent_worktrees.$inferInsert
        | (typeof cloud_agent_pr_watch_activity.$inferInsert)[]
    ) => {
      if (table === cloud_agent_pr_watch_activity && Array.isArray(values)) {
        watchActivity.push(...values);
        events.push('watchActivity');
        return Promise.resolve();
      }
      if (Array.isArray(values)) throw new Error('Unexpected insert values');
      return {
        onConflictDoNothing: async () => {
          if (!worktrees.some(row => row.worktree_id === values.worktree_id))
            worktrees.push(worktree({ name: null, runtime_locations: [], ...values }));
        },
      };
    },
  });
  const update = (table: unknown) => {
    if (table === cloud_agent_pr_watches) {
      return {
        set: (values: Record<string, unknown>) => ({
          where: (condition: SQL) => ({
            returning: async () => {
              watchUpdates.push({ condition, values });
              const query = new PgDialect().sqlToQuery(condition);
              const finished = watches.filter(
                watch =>
                  watch.worktree_id === query.params[0] &&
                  watch.kilo_user_id === query.params[1] &&
                  watch.organization_id === (query.params[2] ?? null) &&
                  watch.status !== 'finished'
              );
              for (const watch of finished) {
                watch.status = 'finished';
                watch.generation += 1;
                watch.lifecycle_reason = 'source_worktree_deleted';
                watch.projection = {
                  ...(watch.projection as object),
                  pending: [],
                  needsAttention: false,
                };
              }
              events.push('finishWatches');
              return finished;
            },
          }),
        }),
      };
    }
    return {
      set: (
        values: Partial<CloudAgentWorktree> & {
          parent_session_id?: string;
          cloud_agent_session_scope_id?: string;
          cloud_agent_worktree_id?: string;
        }
      ) => {
        const query = {
          where: (condition: SQL) => {
            transactionWrote = true;
            if (table === cli_sessions_v2) {
              ownershipUpdates.push({ values, condition });
              throw new Error('Session ownership updates are forbidden during deletion');
            } else {
              Object.assign(worktrees[0], values);
              events.push('updateWorktree');
            }
            return query;
          },
          returning: async () => [worktrees[0]],
          then: (resolve: (result: undefined) => unknown) => resolve(undefined),
        };
        return query;
      },
    };
  };
  const remove = () => ({
    where: (condition: SQL) => ({
      returning: async () => {
        transactionWrote = true;
        const ids = valuesOf(condition);
        const deleted = members.filter(row => row.userId === userId && ids.includes(row.sessionId));
        if (
          members.some(
            row =>
              !deleted.includes(row) &&
              deleted.some(
                parent => parent.userId === row.userId && parent.sessionId === row.parentSessionId
              )
          )
        )
          throw new Error('cli_sessions_v2_parent_session_id_kilo_user_id_fk');
        events.push('deleteRows');
        for (let index = members.length - 1; index >= 0; index--)
          if (deleted.includes(members[index])) members.splice(index, 1);
        return deleted.map(row => ({
          sessionId: row.sessionId,
          parentSessionId: row.parentSessionId,
          organizationId: row.organizationId,
          gitUrl: row.gitUrl ?? null,
          gitBranch: row.gitBranch ?? null,
          createdOnPlatform: row.createdOnPlatform ?? null,
        }));
      },
    }),
  });
  const tx = {
    select,
    insert,
    update,
    delete: remove,
    execute: async (query: SQL) => {
      const compiled = new PgDialect().sqlToQuery(query);
      sqlQueries.push(compiled);
      return {
        rows: members
          .filter(row => row.userId === compiled.params[0] && row.worktreeId === compiled.params[1])
          .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
          .map(
            ({
              sessionId,
              cloudAgentSessionId,
              cloudAgentSessionScopeId,
              userId,
              organizationId,
              worktreeId,
            }) => ({
              sessionId,
              cloudAgentSessionId,
              cloudAgentSessionScopeId: cloudAgentSessionScopeId ?? null,
              userId,
              organizationId,
              worktreeId,
            })
          ),
      };
    },
  };
  let commitError: Error | undefined;
  let failCommitAtWrite: number | undefined;
  let committedWrites = 0;
  const db = {
    ...tx,
    transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      const previousWorktrees = structuredClone(worktrees);
      const previousMembers = structuredClone(members);
      inTransaction = true;
      transactionWrote = false;
      const previousWatches = structuredClone(watches);
      const previousActivity = structuredClone(watchActivity);
      try {
        const result = await callback(tx);
        if (commitError && transactionWrote) {
          committedWrites += 1;
          if (failCommitAtWrite === undefined || committedWrites === failCommitAtWrite)
            throw commitError;
        }
        events.push('commit');
        return result;
      } catch (error) {
        worktrees.splice(0, worktrees.length, ...previousWorktrees);
        members.splice(0, members.length, ...previousMembers);
        watches.splice(0, watches.length, ...previousWatches);
        watchActivity.splice(0, watchActivity.length, ...previousActivity);
        throw error;
      } finally {
        inTransaction = false;
      }
    },
  };
  mocks.getDb.mockReturnValue(db);
  const cleared = new Set<string>();
  const readSnapshot = vi.fn((): Promise<never> => {
    throw new Error('Historical snapshot reads are forbidden during deletion');
  });
  let failure: string | undefined;
  mocks.ingest.mockImplementation(() => ({
    readKiloSdkSessionSnapshot: readSnapshot,
    clearForWorktree: async (_user: string, session: string) => {
      if (failure === session) throw new Error('R2 temporarily unavailable');
      cleared.add(session);
      events.push(`clear:${session}`);
    },
  }));
  mocks.cache.mockReturnValue({ deleteSession: async () => undefined });
  const notifications: { kiloUserId: string; event: SessionEventPayload }[] = [];
  const pendingNotifications: Promise<unknown>[] = [];
  const executionContext: ExecutionContext = {
    waitUntil: promise => {
      pendingNotifications.push(promise);
    },
    passThroughOnException: () => undefined,
    props: {},
  };
  mocks.connection.mockImplementation((_env: Env, { kiloUserId }: { kiloUserId: string }) => ({
    clearSession: async () => undefined,
    notifySessionEvent: async (event: SessionEventPayload) => {
      notifications.push({ kiloUserId, event });
      events.push('notifySessionEvent');
    },
  }));
  return {
    db,
    tx,
    worktrees,
    watches,
    watchActivity,
    watchUpdates,
    members,
    allocations,
    events,
    sqlQueries,
    childQueries,
    candidateQueries,
    ownershipUpdates,
    ledgerReads,
    cleared,
    readSnapshot,
    notifications,
    pendingNotifications,
    executionContext,
    failCommit: (error?: Error, atWrite?: number) => {
      commitError = error;
      failCommitAtWrite = atWrite;
    },
    denyMembership: () => {
      membershipAllowed = false;
    },
    fail: (id?: string) => {
      failure = id;
    },
    freezeWorktreeReads: () => {
      frozenWorktreeReads = structuredClone(worktrees);
    },
  };
}

beforeEach(() => vi.resetAllMocks());

describe('durable worktree deletion journal', () => {
  it.each(['none', 'ingest', 'transaction'] as const)(
    'reports bounded SQL and DO timing summaries on failure=%s',
    async failure => {
      const fail = failure !== 'none';
      const f = database(2, 1);
      const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      try {
        await beginWorktreeDeletion(env, params);
        await recordWorktreeCleanup(env, params);
        if (failure === 'ingest') f.fail(kiloId(1));
        if (failure === 'transaction') f.failCommit(new Error('commit unavailable'));
        if (fail) await expect(completeWorktreeDeletion(env, params)).rejects.toThrow();
        else await completeWorktreeDeletion(env, params);
        expect(log.mock.calls[0][0]).toMatchObject({
          operation: 'begin',
          sqlTransactionMs: expect.any(Number),
        });
        expect(log.mock.calls[1][0]).toMatchObject({
          operation: 'record_cleanup',
          sqlTransactionMs: expect.any(Number),
        });
        expect(log.mock.calls[1][0]).not.toHaveProperty('lineageInferenceMs');
        const summaries = [...log.mock.calls, ...warn.mock.calls]
          .map(([fields]) => fields)
          .filter(fields => typeof fields === 'object' && fields.event === 'worktree_deletion');
        const summary = summaries.find(fields => fields.operation === 'complete');
        expect(summary).toMatchObject({
          event: 'worktree_deletion',
          operation: 'complete',
          worktreeId,
          sessionCount: 3,
          ok: !fail,
          durationMs: expect.any(Number),
          readStateMs: expect.any(Number),
          ingestCleanupMs: expect.any(Number),
          accessCacheCleanupMs: expect.any(Number),
          connectionCleanupMs: expect.any(Number),
        });
        if (failure === 'ingest') {
          expect(summary).toMatchObject({ stage: 'ingestCleanup' });
          expect(summary).not.toHaveProperty('sqlTransactionMs');
        } else {
          expect(summary).toHaveProperty('sqlTransactionMs', expect.any(Number));
          if (failure === 'transaction') expect(summary).toMatchObject({ stage: 'sqlTransaction' });
        }
        expect(summaries).toHaveLength(3);
        expect(JSON.stringify(summary)).not.toContain(userId);
        expect(JSON.stringify(summary)).not.toContain(kiloId(0));
      } finally {
        log.mockRestore();
        warn.mockRestore();
      }
    }
  );

  it.each([null, organizationId])(
    'publishes only committed root and descendant deletions in scope %s, once per deleted row',
    async scope => {
      const f = database(2, 2);
      const scopedParams = { ...params, ...(scope ? { organizationId: scope } : {}) };
      f.worktrees[0].organization_id = scope;
      for (const row of f.members) {
        row.organizationId = scope;
        row.gitUrl = `https://github.com/acme/repo-${row.sessionId}`;
        row.gitBranch = `branch-${row.sessionId}`;
        row.createdOnPlatform = row.cloudAgentSessionId ? 'cloud-agent-web' : 'cli';
      }
      const expectedEvents = f.members.map(row => ({
        kiloUserId: userId,
        event: {
          type: 'session.deleted',
          data: {
            source: 'v2',
            sessionId: row.sessionId,
            parentSessionId: row.parentSessionId,
            organizationId: scope,
            gitUrl: row.gitUrl,
            gitBranch: row.gitBranch,
            createdOnPlatform: row.createdOnPlatform,
            deletedAt: expect.any(String),
          },
        },
      }));
      const unrelated: Member = {
        sessionId: kiloId(50),
        cloudAgentSessionId: cloudId(50),
        organizationId: scope,
        worktreeId: otherWorktreeId,
        userId,
        parentSessionId: null,
      };
      f.members.push(unrelated);
      await beginWorktreeDeletion(env, scopedParams);
      await recordWorktreeCleanup(env, { ...scopedParams, sessionIds: [kiloId(99)] });
      expect(f.notifications).toEqual([]);

      const result = await completeWorktreeDeletion(env, scopedParams, f.executionContext);
      await Promise.all(f.pendingNotifications);
      expect(result).toEqual({
        success: true,
        deletedSessionIds: [kiloId(0), kiloId(1), kiloId(2), kiloId(3), kiloId(99)],
      });
      expect(f.notifications).toHaveLength(4);
      expect(f.notifications).toEqual(expect.arrayContaining(expectedEvents));
      expect(f.pendingNotifications).toHaveLength(4);
      const firstNotification = f.events.indexOf('notifySessionEvent');
      expect(firstNotification).toBeGreaterThan(f.events.indexOf('deleteRows'));
      // The content transaction committed before the first event. The tombstone
      // is a later transaction and must not gate event delivery.
      expect(f.events.lastIndexOf('commit', firstNotification)).toBeGreaterThan(
        f.events.indexOf('deleteRows')
      );
      expect(f.members).toEqual([unrelated]);

      await expect(
        completeWorktreeDeletion(env, scopedParams, f.executionContext)
      ).resolves.toEqual(result);
      expect(f.notifications).toHaveLength(4);
      expect(f.pendingNotifications).toHaveLength(4);
    }
  );

  it('does not publish deletions when SQL commit fails and publishes once after a successful retry', async () => {
    const f = database(2, 1);
    await beginWorktreeDeletion(env, params);
    f.failCommit(new Error('transaction commit failed'));
    await expect(completeWorktreeDeletion(env, params, f.executionContext)).rejects.toThrow(
      'transaction commit failed'
    );
    expect(f.events).toContain('deleteRows');
    expect(f.members).toHaveLength(3);
    expect(f.worktrees[0].deletion_completed_at).toBeNull();
    expect(f.notifications).toEqual([]);
    expect(f.pendingNotifications).toEqual([]);

    f.failCommit();
    await completeWorktreeDeletion(env, params, f.executionContext);
    await Promise.all(f.pendingNotifications);
    expect(f.members).toEqual([]);
    expect(f.notifications).toHaveLength(3);
  });

  it('publishes deletion events after content commit so a tombstone failure cannot lose them', async () => {
    const f = database();
    await beginWorktreeDeletion(env, params);
    const manifest = structuredClone(f.worktrees[0].deletion_manifest);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      // The content transaction is write 1; the tombstone transaction is write 2.
      f.failCommit(new Error('tombstone commit failed'), 2);
      await expect(completeWorktreeDeletion(env, params, f.executionContext)).rejects.toThrow(
        'tombstone commit failed'
      );
      await Promise.all(f.pendingNotifications);

      expect(f.members).toEqual([]);
      expect(f.worktrees[0]).toMatchObject({
        deletion_completed_at: null,
        deletion_manifest: manifest,
        runtime_locations: [location],
      });
      expect(f.notifications).toHaveLength(1);

      f.failCommit();
      await expect(completeWorktreeDeletion(env, params, f.executionContext)).resolves.toEqual({
        success: true,
        deletedSessionIds: [kiloId(0)],
      });
      await Promise.all(f.pendingNotifications);
      expect(f.notifications).toHaveLength(1);
      expect(f.worktrees[0].deletion_completed_at).not.toBeNull();
      expect(f.worktrees[0].deletion_manifest).toBeNull();
    } finally {
      warn.mockRestore();
    }
  });

  it('journals a runtime-only never-run child, retains it after partial cleanup, and replays its tombstone', async () => {
    const f = database();
    const initial = await beginWorktreeDeletion(env, params);
    expect(initial.manifest.sessions.map(row => row.sessionId)).toEqual([kiloId(0)]);
    await recordWorktreeCleanup(env, {
      ...params,
      childSessions: [
        { sessionId: kiloId(1), parentSessionId: kiloId(0), cloudAgentSessionId: cloudId(0) },
      ],
    });
    f.fail(kiloId(1));
    await expect(completeWorktreeDeletion(env, params)).rejects.toThrow(
      'R2 temporarily unavailable'
    );
    expect(f.members).toHaveLength(1);
    expect(f.worktrees[0].deletion_completed_at).toBeNull();
    expect(f.worktrees[0].runtime_locations).toEqual([location]);
    expect(f.worktrees[0].name).toBe('Private worktree name');
    f.fail();
    await expect(completeWorktreeDeletion(env, params)).resolves.toEqual({
      success: true,
      deletedSessionIds: [kiloId(0), kiloId(1)],
    });
    expect(f.members).toEqual([]);
    expect(f.cleared).toEqual(new Set([kiloId(0), kiloId(1)]));
    await expect(beginWorktreeDeletion(env, params)).resolves.toMatchObject({
      completed: true,
      manifest: { sessions: [{ sessionId: kiloId(0) }, { sessionId: kiloId(1) }] },
    });
    mocks.ingest.mockClear();
    await expect(recordWorktreeCleanup(env, params)).resolves.toMatchObject({ completed: true });
    await expect(completeWorktreeDeletion(env, params)).resolves.toEqual({
      success: true,
      deletedSessionIds: [kiloId(0), kiloId(1)],
    });
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(f.readSnapshot).not.toHaveBeenCalled();
    expect(f.ownershipUpdates).toEqual([]);
  });

  it('reads the cleanup manifest inside a transaction so a cached pre-cleanup row cannot fail completion', async () => {
    const f = database();
    await beginWorktreeDeletion(env, params);
    f.members.push({
      sessionId: kiloId(1),
      cloudAgentSessionId: null,
      cloudAgentSessionScopeId: cloudId(0),
      organizationId: null,
      worktreeId,
      userId,
      parentSessionId: kiloId(0),
    });
    f.freezeWorktreeReads();
    await recordWorktreeCleanup(env, {
      ...params,
      childSessions: [
        { sessionId: kiloId(1), parentSessionId: kiloId(0), cloudAgentSessionId: cloudId(0) },
      ],
    });

    await expect(completeWorktreeDeletion(env, params)).resolves.toEqual({
      success: true,
      deletedSessionIds: [kiloId(0), kiloId(1)],
    });
    expect(f.members).toEqual([]);
  });

  it('journals out-of-order runtime-only descendants under their actual roots without creating SQL ownership', async () => {
    const f = database(2, 1);
    await beginWorktreeDeletion(env, params);
    const cleanup = {
      ...params,
      childSessions: [
        { sessionId: kiloId(4), parentSessionId: kiloId(3), cloudAgentSessionId: cloudId(1) },
        { sessionId: kiloId(5), parentSessionId: kiloId(2), cloudAgentSessionId: cloudId(0) },
        { sessionId: kiloId(3), parentSessionId: kiloId(1), cloudAgentSessionId: cloudId(1) },
      ],
    };
    const recorded = await recordWorktreeCleanup(env, cleanup);
    expect(recorded.manifest.sessions.map(row => row.sessionId).sort()).toEqual(
      Array.from({ length: 6 }, (_, index) => kiloId(index))
    );
    expect((await recordWorktreeCleanup(env, cleanup)).manifest).toEqual(recorded.manifest);
    expect(f.members).toHaveLength(3);
    expect(f.ownershipUpdates).toEqual([]);
    await completeWorktreeDeletion(env, params);
    expect(f.members).toEqual([]);
    expect(f.cleared).toEqual(new Set(Array.from({ length: 6 }, (_, index) => kiloId(index))));
  });

  it.each([
    ['unscoped', { cloudAgentSessionScopeId: null, worktreeId: null, parentSessionId: null }],
    ['missing worktree', { worktreeId: null }],
    ['foreign worktree', { worktreeId: otherWorktreeId }],
    ['foreign owner', { worktreeId: otherWorktreeId, userId: 'another-owner' }],
    ['foreign organization', { worktreeId: otherWorktreeId, organizationId }],
    ['foreign scope', { worktreeId: otherWorktreeId, cloudAgentSessionScopeId: cloudId(9) }],
    ['missing scope', { worktreeId: otherWorktreeId, cloudAgentSessionScopeId: null }],
  ] satisfies [string, Partial<Member>][])(
    'rejects %s persisted IDs returned by the runtime without changing their ownership',
    async (_name, overrides) => {
      const f = database();
      await beginWorktreeDeletion(env, params);
      f.members.push({
        sessionId: kiloId(1),
        cloudAgentSessionId: null,
        cloudAgentSessionScopeId: cloudId(0),
        organizationId: null,
        userId,
        parentSessionId: kiloId(0),
        ...overrides,
      });
      const before = structuredClone(f.members);
      const manifest = structuredClone(f.worktrees[0].deletion_manifest);
      await expect(
        recordWorktreeCleanup(env, {
          ...params,
          childSessions: [
            { sessionId: kiloId(1), parentSessionId: kiloId(0), cloudAgentSessionId: cloudId(0) },
          ],
        })
      ).rejects.toThrow('worktree_child_lineage_conflict');
      expect(f.members).toEqual(before);
      expect(f.worktrees[0].deletion_manifest).toEqual(manifest);
      expect(f.ownershipUpdates).toEqual([]);
      expect(f.cleared.size).toBe(0);
    }
  );

  it('does not adopt a personal unscoped runtime child into an organization workspace', async () => {
    const f = database();
    f.worktrees[0].organization_id = organizationId;
    f.members[0].organizationId = organizationId;
    f.members.push({
      sessionId: kiloId(1),
      cloudAgentSessionId: null,
      cloudAgentSessionScopeId: null,
      organizationId: null,
      worktreeId: null,
      userId,
      parentSessionId: null,
    });
    const scopedParams = { ...params, organizationId };
    await beginWorktreeDeletion(env, scopedParams);
    await expect(
      recordWorktreeCleanup(env, {
        ...scopedParams,
        childSessions: [
          { sessionId: kiloId(1), parentSessionId: kiloId(0), cloudAgentSessionId: cloudId(0) },
        ],
      })
    ).rejects.toThrow('worktree_child_lineage_conflict');
    expect(f.members[1]).toMatchObject({ organizationId: null, worktreeId: null });
    expect(f.ownershipUpdates).toEqual([]);
  });

  it('rejects runtime lineage that flattens an existing nested parent within the same scope', async () => {
    const f = database(1, 2);
    const before = structuredClone(f.members);
    await beginWorktreeDeletion(env, params);
    await expect(
      recordWorktreeCleanup(env, {
        ...params,
        childSessions: [
          { sessionId: kiloId(2), parentSessionId: kiloId(0), cloudAgentSessionId: cloudId(0) },
        ],
      })
    ).rejects.toThrow('worktree_child_lineage_conflict');
    expect(f.members).toEqual(before);
    expect(f.ownershipUpdates).toEqual([]);
  });

  it.each(['missing parent', 'cycle', 'another root'])(
    'rejects a runtime child whose registered ancestors reach %s instead of its root',
    async invalid => {
      const f = database(2, 2);
      f.members[2].parentSessionId = kiloId(
        invalid === 'missing parent' ? 99 : invalid === 'cycle' ? 3 : 1
      );
      await beginWorktreeDeletion(env, params);
      const manifest = structuredClone(f.worktrees[0].deletion_manifest);
      await expect(
        recordWorktreeCleanup(env, {
          ...params,
          childSessions: [
            { sessionId: kiloId(4), parentSessionId: kiloId(3), cloudAgentSessionId: cloudId(0) },
          ],
        })
      ).rejects.toThrow('worktree_child_lineage_conflict');
      expect(f.worktrees[0].deletion_manifest).toEqual(manifest);
      expect(f.ownershipUpdates).toEqual([]);
    }
  );

  it.each(['missing parent', 'cycle', 'self parent', 'root child', 'foreign root', 'conflict'])(
    'rejects runtime-only lineage with %s without growing the journal',
    async invalid => {
      const f = database();
      await beginWorktreeDeletion(env, params);
      const manifest = structuredClone(f.worktrees[0].deletion_manifest);
      const childSessions = [
        {
          sessionId: invalid === 'root child' ? kiloId(0) : kiloId(1),
          parentSessionId:
            invalid === 'missing parent' || invalid === 'cycle'
              ? kiloId(2)
              : invalid === 'self parent'
                ? kiloId(1)
                : kiloId(0),
          cloudAgentSessionId: cloudId(invalid === 'foreign root' ? 9 : 0),
        },
      ];
      if (invalid === 'cycle')
        childSessions.push({
          sessionId: kiloId(2),
          parentSessionId: kiloId(1),
          cloudAgentSessionId: cloudId(0),
        });
      if (invalid === 'conflict')
        childSessions.push({
          sessionId: kiloId(1),
          parentSessionId: kiloId(2),
          cloudAgentSessionId: cloudId(0),
        });
      await expect(recordWorktreeCleanup(env, { ...params, childSessions })).rejects.toThrow(
        'worktree_child_lineage_conflict'
      );
      expect(f.worktrees[0].deletion_manifest).toEqual(manifest);
      expect(f.ownershipUpdates).toEqual([]);
    }
  );

  it.each(['throws', 'hangs'] as const)(
    'deletes registered never-run and nested children without scanning unrelated CLI roots when snapshots %s',
    async snapshotFailure => {
      const f = database(2, 3);
      if (snapshotFailure === 'hangs')
        f.readSnapshot.mockImplementation(() => new Promise<never>(() => undefined));
      const unrelated = Array.from({ length: 1_000 }, (_, index): Member => ({
        sessionId: kiloId(100 + index),
        cloudAgentSessionId: null,
        cloudAgentSessionScopeId: null,
        organizationId: null,
        worktreeId: null,
        userId,
        parentSessionId: null,
      }));
      f.members.push(...unrelated);
      const state = await beginWorktreeDeletion(env, params);
      expect(state.manifest.sessions.map(row => row.sessionId)).toEqual(
        Array.from({ length: 5 }, (_, index) => kiloId(index))
      );
      await recordWorktreeCleanup(env, {
        ...params,
        directory: '/workspace/app',
        childSessions: [
          { sessionId: kiloId(4), parentSessionId: kiloId(3), cloudAgentSessionId: cloudId(0) },
          { sessionId: kiloId(3), parentSessionId: kiloId(2), cloudAgentSessionId: cloudId(0) },
          { sessionId: kiloId(2), parentSessionId: kiloId(0), cloudAgentSessionId: cloudId(0) },
        ],
      });
      await expect(completeWorktreeDeletion(env, params)).resolves.toEqual({
        success: true,
        deletedSessionIds: Array.from({ length: 5 }, (_, index) => kiloId(index)),
      });
      expect(f.cleared).toEqual(new Set(Array.from({ length: 5 }, (_, index) => kiloId(index))));
      expect(f.members).toEqual(unrelated);
      expect(f.readSnapshot).not.toHaveBeenCalled();
      expect(f.candidateQueries).toEqual([]);
      expect(f.ownershipUpdates).toEqual([]);
      expect(f.ledgerReads).toEqual([]);
      for (const query of f.sqlQueries) {
        expect(query.sql).toContain('WHERE kilo_user_id =');
        expect(query.sql).toContain('AND cloud_agent_worktree_id =');
        expect(query.sql).not.toMatch(/RECURSIVE|JOIN/);
        expect(query.params).toEqual([userId, worktreeId]);
      }
    }
  );

  it.each([null, otherWorktreeId])(
    'rejects a parent-linked child registered to %s before fencing or cleaning the workspace',
    async childWorktreeId => {
      const f = database(1, 2);
      f.members[2].worktreeId = childWorktreeId;
      f.members[2].cloudAgentSessionScopeId = null;
      f.members[2].organizationId = organizationId;
      const members = structuredClone(f.members);

      await expect(beginWorktreeDeletion(env, params)).rejects.toThrow(
        'worktree_unregistered_child_sessions'
      );
      expect(f.worktrees[0].deletion_started_at).toBeNull();
      expect(f.worktrees[0].deletion_manifest).toBeNull();
      expect(f.members).toEqual(members);
      expect(f.cleared.size).toBe(0);
      expect(f.ownershipUpdates).toEqual([]);
      expect(f.childQueries).toHaveLength(1);
      expect(f.childQueries[0].sql).toContain('"parent_session_id" in');
      expect(f.childQueries[0].sql).toContain('"session_id" not in');
      expect(f.childQueries[0].params).toEqual([
        userId,
        kiloId(0),
        kiloId(1),
        kiloId(0),
        kiloId(1),
      ]);
      expect(f.readSnapshot).not.toHaveBeenCalled();
    }
  );

  it.each(['begin', 'record', 'complete'] as const)(
    'rechecks parent-linked children during %s of an existing deletion journal',
    async phase => {
      const f = database(1, 1);
      await beginWorktreeDeletion(env, params);
      const journal = structuredClone(f.worktrees[0]);
      f.members.push({
        sessionId: kiloId(2),
        cloudAgentSessionId: null,
        cloudAgentSessionScopeId: cloudId(0),
        worktreeId: null,
        organizationId: null,
        userId,
        parentSessionId: kiloId(1),
      });
      const run =
        phase === 'begin'
          ? beginWorktreeDeletion
          : phase === 'record'
            ? recordWorktreeCleanup
            : completeWorktreeDeletion;
      await expect(run(env, params)).rejects.toThrow('worktree_unregistered_child_sessions');
      expect(f.worktrees[0]).toEqual(journal);
      expect(f.members).toHaveLength(3);
      expect(f.cleared.size).toBe(0);
      expect(f.events).not.toContain('deleteRows');
    }
  );

  it('does not follow root-scope pointers outside registered worktree membership', async () => {
    const f = database(1, 3);
    f.members[1].worktreeId = null;
    f.members[1].parentSessionId = null;
    f.members[2].worktreeId = otherWorktreeId;
    f.members[3].worktreeId = null;
    f.members[3].parentSessionId = null;
    await beginWorktreeDeletion(env, params);
    await recordWorktreeCleanup(env, params);
    await expect(completeWorktreeDeletion(env, params)).resolves.toEqual({
      success: true,
      deletedSessionIds: [kiloId(0)],
    });
    expect(f.members.map(row => row.sessionId)).toEqual([kiloId(1), kiloId(2), kiloId(3)]);
    expect(f.ownershipUpdates).toEqual([]);
  });

  it('rechecks the parent FK boundary when an unregistered child appears during ingest cleanup', async () => {
    const f = database();
    await beginWorktreeDeletion(env, params);
    mocks.ingest.mockReturnValue({
      clearForWorktree: async () => {
        f.members.push({
          sessionId: kiloId(1),
          cloudAgentSessionId: null,
          cloudAgentSessionScopeId: null,
          organizationId: null,
          worktreeId: null,
          userId,
          parentSessionId: kiloId(0),
        });
      },
    });
    await expect(completeWorktreeDeletion(env, params)).rejects.toThrow(
      'worktree_unregistered_child_sessions'
    );
    expect(f.members).toHaveLength(2);
    expect(f.worktrees[0].deletion_completed_at).toBeNull();
    expect(f.events).not.toContain('deleteRows');
  });

  it.each(['organization', 'scope', 'unscoped'] as const)(
    'rejects a registered member with mismatched %s without adopting it',
    async field => {
      const f = database(1, 1);
      if (field === 'organization') f.members[1].organizationId = organizationId;
      if (field === 'scope') f.members[1].cloudAgentSessionScopeId = cloudId(9);
      if (field === 'unscoped') f.members[1].cloudAgentSessionScopeId = null;
      await expect(beginWorktreeDeletion(env, params)).rejects.toThrow('worktree_access_denied');
      expect(f.worktrees[0].deletion_started_at).toBeNull();
      expect(f.ownershipUpdates).toEqual([]);
      expect(f.cleared.size).toBe(0);
    }
  );

  it('does not include another owner even when a row references the same worktree ID', async () => {
    const f = database(1, 1);
    f.members[1].userId = 'another-owner';
    const foreign = structuredClone(f.members[1]);
    await beginWorktreeDeletion(env, params);
    await recordWorktreeCleanup(env, params);
    await expect(completeWorktreeDeletion(env, params)).resolves.toEqual({
      success: true,
      deletedSessionIds: [kiloId(0)],
    });
    expect(f.members).toEqual([foreign]);
    expect(f.cleared).toEqual(new Set([kiloId(0)]));
  });

  it('rejects retained lineage that spoofs a different root even inside the same worktree', async () => {
    const f = database(2);
    f.members.push({
      sessionId: kiloId(2),
      cloudAgentSessionId: null,
      cloudAgentSessionScopeId: null,
      organizationId: null,
      worktreeId: null,
      userId,
      parentSessionId: null,
    });
    await beginWorktreeDeletion(env, params);
    await expect(
      recordWorktreeCleanup(env, {
        ...params,
        childSessions: [
          { sessionId: kiloId(2), parentSessionId: kiloId(1), cloudAgentSessionId: cloudId(0) },
        ],
      })
    ).rejects.toThrow('worktree_child_lineage_conflict');
    expect(f.members[2]).toMatchObject({
      parentSessionId: null,
      cloudAgentSessionScopeId: null,
      worktreeId: null,
    });
    expect(f.cleared.size).toBe(0);
  });

  it.each([null, otherWorktreeId])(
    'does not count an unrelated %s root allocation as physical sharing',
    async unrelatedWorktreeId => {
      const f = database();
      await beginWorktreeDeletion(env, params);
      const unrelatedCloudId = unrelatedWorktreeId
        ? `workspace_${unrelatedWorktreeId.slice('worktree_'.length)}`
        : 'agent_44444444-4444-4444-8444-444444444444';
      if (unrelatedWorktreeId)
        f.worktrees.push(worktree({ worktree_id: unrelatedWorktreeId, runtime_locations: [] }));
      f.members.push({
        sessionId: kiloId(1),
        cloudAgentSessionId: unrelatedCloudId,
        organizationId: null,
        worktreeId: unrelatedWorktreeId,
        userId,
        parentSessionId: null,
      });
      f.allocations.push({
        kilo_user_id: userId,
        organization_id: null,
        intent: 'create_cloud',
        resource_key: null,
        canonical_result: {
          cloudAgentSessionId: unrelatedCloudId,
          kiloSessionId: kiloId(1),
          sandboxId: 'ses-unrelated-original',
          sandboxProvider: 'vercel',
        },
      });
      const result = await canDestroyWorktreeSandbox(env, { ...params, location });
      if (unrelatedWorktreeId) expect(result).toEqual({ kind: 'exclusive' });
      else
        expect(result).toMatchObject({
          kind: 'unresolved',
          owners: [
            { allocationLocation: { sandboxId: 'ses-unrelated-original', provider: 'vercel' } },
          ],
        });
    }
  );

  it('uses the registered location for an unopened root without reading DO or allocation history', async () => {
    const f = database();
    const first = await beginWorktreeDeletion(env, params);
    expect(first.runtimeLocations).toEqual([location]);
    expect(f.worktrees[0].deletion_started_at).not.toBeNull();
    const retry = await beginWorktreeDeletion(env, params);
    expect(retry).toEqual(first);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(f.ledgerReads).toEqual([]);
  });

  it('does not query allocation ledgers when recorded locations are missing, including retries', async () => {
    const f = database();
    const originalCloudId = `workspace_${worktreeId.slice('worktree_'.length)}`;
    f.members[0].cloudAgentSessionId = originalCloudId;
    f.worktrees[0].runtime_locations = [];
    expect((await beginWorktreeDeletion(env, params)).runtimeLocations).toEqual([]);
    const started = f.worktrees[0].deletion_started_at;
    f.allocations.push({
      kilo_user_id: userId,
      organization_id: null,
      intent: 'create_cloud',
      resource_key: null,
      canonical_result: {
        cloudAgentSessionId: originalCloudId,
        kiloSessionId: kiloId(0),
        sandboxId: 'usr-persisted-override',
        sandboxProvider: 'cloudflare',
      },
    });
    expect((await beginWorktreeDeletion(env, params)).runtimeLocations).toEqual([]);
    expect(f.worktrees[0].deletion_started_at).toBe(started);
    expect(f.ledgerReads).toEqual([]);
    expect(f.worktrees[0].runtime_locations).toEqual([]);
  });

  it('excludes acknowledged scoped cleanup only for worktrees whose admission has been fenced', async () => {
    const f = database();
    await beginWorktreeDeletion(env, params);
    f.worktrees.push(worktree({ worktree_id: otherWorktreeId }));
    const input = {
      ...params,
      location,
      releasedWorktreeIds: [otherWorktreeId],
    } satisfies CanDestroyCloudAgentWorktreeSandboxParams;
    await expect(canDestroyWorktreeSandbox(env, input)).resolves.toEqual({ kind: 'shared' });
    f.worktrees[1].deletion_started_at = '2026-08-27 01:00:00+00';
    await expect(canDestroyWorktreeSandbox(env, input)).resolves.toEqual({ kind: 'exclusive' });
  });

  it('denies a different owner and personal/org scope confusion before starting deletion', async () => {
    const f = database();
    await expect(
      beginWorktreeDeletion(env, { ...params, kiloUserId: 'another-user' })
    ).rejects.toThrow('access_denied');
    await expect(beginWorktreeDeletion(env, { ...params, organizationId })).rejects.toThrow(
      'access_denied'
    );
    expect(f.worktrees[0].deletion_started_at).toBeNull();
    expect(f.events).not.toContain('deleteRows');
  });

  it('denies lost or soft-deleted organization membership on completed tombstone retries', async () => {
    const f = database(0);
    f.worktrees[0] = worktree({
      organization_id: organizationId,
      deletion_started_at: '2026-08-27 02:00:00+00',
      deletion_completed_at: '2026-08-27 02:01:00+00',
      name: null,
      deleted_session_ids: [kiloId(0)],
    });
    f.denyMembership();
    await expect(beginWorktreeDeletion(env, { ...params, organizationId })).rejects.toThrow(
      'access_denied'
    );
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it('reads all registered roots and descendants without a UI limit and keeps the manifest after rows disappear', async () => {
    const f = database(205, 15);
    const state = await beginWorktreeDeletion(env, params);
    expect(state.manifest.sessions).toHaveLength(220);
    expect(f.events.indexOf('lockWorktree')).toBeLessThan(f.events.indexOf('lockRoots'));
    expect(f.sqlQueries[0].sql).not.toContain('WITH RECURSIVE');
    expect(f.sqlQueries[0].sql).not.toMatch(/limit|depth\s*</i);
    expect(f.sqlQueries[0].params).toEqual([userId, worktreeId]);
    f.members.length = 0;
    expect((await beginWorktreeDeletion(env, params)).manifest.sessions).toEqual(
      state.manifest.sessions
    );
  });

  it('rejects a missing registry instead of recreating it from session rows', async () => {
    const f = database(2);
    f.worktrees.length = 0;
    await expect(beginWorktreeDeletion(env, params)).rejects.toThrow('worktree_access_denied');
    expect(f.worktrees).toEqual([]);
    expect(f.members).toHaveLength(2);
    expect(f.sqlQueries).toEqual([]);
    expect(f.ledgerReads).toEqual([]);
  });

  it('rejects new root registration under the same locked worktree after deletion begins', async () => {
    const f = database();
    await beginWorktreeDeletion(env, params);
    await expect(
      registerCloudAgentWorktree(f.tx as never, {
        sessionId: kiloId(100),
        kiloUserId: userId,
        cloudAgentSessionId: cloudId(100),
        cloudAgentWorktreeId: worktreeId,
        cloudAgentWorktreeLocation: location,
        createdOnPlatform: 'cloud-agent-web',
      })
    ).rejects.toThrow('worktree_deleting');
    expect(f.worktrees[0].kilo_user_id).toBe(userId);
    expect(f.worktrees[0].organization_id).toBeNull();
  });

  it('retains rows, names, and retry locators until every targeted ingest cleanup succeeds', async () => {
    const f = database(2, 1);
    await beginWorktreeDeletion(env, params);
    f.fail(kiloId(1));
    await expect(completeWorktreeDeletion(env, params)).rejects.toThrow(
      'R2 temporarily unavailable'
    );
    expect(f.members).toHaveLength(3);
    expect(f.worktrees[0].deletion_completed_at).toBeNull();
    expect(f.worktrees[0].runtime_locations).toEqual([location]);
    expect(f.notifications).toEqual([]);
    f.fail();
    await expect(completeWorktreeDeletion(env, params)).resolves.toEqual({
      success: true,
      deletedSessionIds: [kiloId(0), kiloId(1), kiloId(2)],
    });
    expect(f.events.indexOf('deleteRows')).toBeGreaterThan(
      f.events.lastIndexOf(`clear:${kiloId(2)}`)
    );
    expect(f.members).toHaveLength(0);
    expect(f.worktrees[0]).toMatchObject({
      name: null,
      runtime_locations: [],
      deletion_manifest: null,
    });
    expect(f.worktrees[0].deletion_completed_at).not.toBeNull();
  });

  it.each(['journal', 'membership'] as const)(
    'retains SQL rows when %s grows during cleanup and deletes the expanded set on retry',
    async growth => {
      const f = database();
      await beginWorktreeDeletion(env, params);
      let grew = false;
      mocks.ingest.mockImplementation(() => ({
        clearForWorktree: async (_user: string, sessionId: string) => {
          f.cleared.add(sessionId);
          if (grew) return;
          grew = true;
          if (growth === 'journal')
            await recordWorktreeCleanup(env, {
              ...params,
              childSessions: [
                {
                  sessionId: kiloId(1),
                  parentSessionId: kiloId(0),
                  cloudAgentSessionId: cloudId(0),
                },
              ],
            });
          else
            f.members.push({
              sessionId: kiloId(1),
              cloudAgentSessionId: null,
              cloudAgentSessionScopeId: cloudId(0),
              organizationId: null,
              worktreeId,
              userId,
              parentSessionId: kiloId(0),
            });
        },
      }));
      await expect(completeWorktreeDeletion(env, params)).rejects.toThrow(
        'worktree_cleanup_manifest_changed'
      );
      expect(f.events).not.toContain('deleteRows');
      expect(f.worktrees[0].deletion_completed_at).toBeNull();
      expect(f.worktrees[0].runtime_locations).toEqual([location]);
      await recordWorktreeCleanup(env, params);
      await expect(completeWorktreeDeletion(env, params)).resolves.toEqual({
        success: true,
        deletedSessionIds: [kiloId(0), kiloId(1)],
      });
      expect(f.cleared).toEqual(new Set([kiloId(0), kiloId(1)]));
      expect(f.members).toEqual([]);
    }
  );

  it('journals runtime-only descendants but refuses to claim an unrelated persisted session', async () => {
    const f = database();
    await beginWorktreeDeletion(env, params);
    await recordWorktreeCleanup(env, { ...params, sessionIds: [kiloId(5)] });
    expect(
      cloudAgentWorktreeDeletionManifestSchema
        .parse(f.worktrees[0].deletion_manifest)
        .sessions.map(row => row.sessionId)
    ).toContain(kiloId(5));
    f.members.push({
      sessionId: kiloId(6),
      cloudAgentSessionId: cloudId(6),
      organizationId: null,
      worktreeId: otherWorktreeId,
      userId,
      parentSessionId: null,
    });
    await expect(
      recordWorktreeCleanup(env, { ...params, sessionIds: [kiloId(6)] })
    ).rejects.toThrow('session_conflict');
  });

  it.each(['unscoped', 'foreign owner'])(
    'revalidates a journaled runtime-only ID when a %s SQL row appears before retry',
    async ownership => {
      const f = database();
      await beginWorktreeDeletion(env, params);
      await recordWorktreeCleanup(env, { ...params, sessionIds: [kiloId(5)] });
      f.members.push({
        sessionId: kiloId(5),
        cloudAgentSessionId: null,
        cloudAgentSessionScopeId: null,
        organizationId: null,
        worktreeId: null,
        userId: ownership === 'foreign owner' ? 'another-owner' : userId,
        parentSessionId: null,
      });
      const members = structuredClone(f.members);
      await expect(
        recordWorktreeCleanup(env, { ...params, sessionIds: [kiloId(5)] })
      ).rejects.toThrow('worktree_cleanup_session_conflict');
      expect(f.members).toEqual(members);
      expect(f.ownershipUpdates).toEqual([]);
      expect(f.cleared.size).toBe(0);
    }
  );

  it('journals completed runtime locations idempotently', async () => {
    const f = database();
    await beginWorktreeDeletion(env, params);

    await recordWorktreeCleanup(env, { ...params, completedRuntimeLocation: location });
    const recorded = await recordWorktreeCleanup(env, {
      ...params,
      completedRuntimeLocation: location,
    });

    expect(recorded.manifest.completedRuntimeLocations).toEqual([location]);
    expect(
      cloudAgentWorktreeDeletionManifestSchema.parse(f.worktrees[0].deletion_manifest)
        .completedRuntimeLocations
    ).toEqual([location]);
  });

  it('refuses exclusive teardown for another worktree or an unopened root with unknown runtime ownership', async () => {
    const f = database();
    await beginWorktreeDeletion(env, params);
    await expect(canDestroyWorktreeSandbox(env, { ...params, location })).resolves.toEqual({
      kind: 'exclusive',
    });
    f.worktrees.push(worktree({ worktree_id: otherWorktreeId, runtime_locations: [location] }));
    await expect(canDestroyWorktreeSandbox(env, { ...params, location })).resolves.toEqual({
      kind: 'shared',
    });
    f.worktrees[1].runtime_locations = [{ ...location, sandboxId: 'ses-unrelated' }];
    f.members.push({
      sessionId: kiloId(1),
      cloudAgentSessionId: cloudId(1),
      organizationId: null,
      worktreeId: null,
      userId,
      parentSessionId: null,
    });
    await expect(canDestroyWorktreeSandbox(env, { ...params, location })).resolves.toMatchObject({
      kind: 'unresolved',
    });
    f.members[1].worktreeId = otherWorktreeId;
    await expect(canDestroyWorktreeSandbox(env, { ...params, location })).resolves.toEqual({
      kind: 'exclusive',
    });
    f.members.pop();
    f.worktrees[1].runtime_locations = [];
    await expect(canDestroyWorktreeSandbox(env, { ...params, location })).resolves.toMatchObject({
      kind: 'unresolved',
    });
  });
});

describe('retireWorktreeIfSoleMember', () => {
  const retire = (f: ReturnType<typeof database>) => {
    const worktreeWrites = () => f.events.filter(event => event === 'updateWorktree').length;
    return {
      call: (cloudAgentSessionId = cloudId(0)) =>
        retireWorktreeIfSoleMember(env, { ...params, cloudAgentSessionId }),
      worktreeWrites,
    };
  };

  it('retires a sole member and writes the FULL deletion state under the row lock', async () => {
    const f = database();
    await expect(retire(f).call()).resolves.toEqual({ kind: 'exclusive' });
    expect(f.events.indexOf('lockWorktree')).toBeLessThan(f.events.indexOf('updateWorktree'));
    expect(f.worktrees[0].deletion_started_at).not.toBeNull();
    expect(
      cloudAgentWorktreeDeletionManifestSchema.parse(f.worktrees[0].deletion_manifest)
    ).toEqual({
      version: 1,
      sessions: [{ sessionId: kiloId(0), cloudAgentSessionId: cloudId(0) }],
    });
    expect(f.worktrees[0].runtime_locations).toEqual([location]);
  });

  it('C1: retirement resumes through a later beginWorktreeDeletion and never leaves a marker without a manifest', async () => {
    const f = database();
    await expect(retire(f).call()).resolves.toEqual({ kind: 'exclusive' });
    // A marker-only write would leave deletion_manifest null here and make the
    // public deleteWorktree throw when it replays the manifest.
    expect(f.worktrees[0].deletion_manifest).not.toBeNull();
    await expect(beginWorktreeDeletion(env, params)).resolves.toMatchObject({
      completed: false,
      manifest: {
        version: 1,
        sessions: [{ sessionId: kiloId(0), cloudAgentSessionId: cloudId(0) }],
      },
      runtimeLocations: [location],
    });
  });

  it('C1: retirement preserves the registered runtime location for a later deletion', async () => {
    const f = database();
    await expect(retire(f).call()).resolves.toEqual({ kind: 'exclusive' });
    expect(f.worktrees[0].deletion_manifest).not.toBeNull();
    expect(f.worktrees[0].runtime_locations).toEqual([location]);
    await expect(beginWorktreeDeletion(env, params)).resolves.toMatchObject({
      completed: false,
      manifest: {
        version: 1,
        sessions: [{ sessionId: kiloId(0), cloudAgentSessionId: cloudId(0) }],
      },
      runtimeLocations: [location],
    });
    expect(f.ledgerReads).toEqual([]);
  });

  it('race: a competing registration loses after the retirement marker and throws WORKTREE_DELETING', async () => {
    const f = database();
    await expect(retire(f).call()).resolves.toEqual({ kind: 'exclusive' });
    await expect(
      registerCloudAgentWorktree(f.tx as never, {
        sessionId: kiloId(100),
        kiloUserId: userId,
        cloudAgentSessionId: cloudId(100),
        cloudAgentWorktreeId: worktreeId,
        cloudAgentWorktreeLocation: location,
        createdOnPlatform: 'cloud-agent-web',
      })
    ).rejects.toThrow('worktree_deleting');
    expect(f.worktrees[0].deletion_started_at).not.toBeNull();
    expect(f.members).toHaveLength(1);
  });

  it('treats an already-set marker with exact nonempty membership as exclusive and writes nothing new', async () => {
    const f = database();
    await retire(f).call();
    const writes = retire(f).worktreeWrites();
    const started = f.worktrees[0].deletion_started_at;
    await expect(retire(f).call()).resolves.toEqual({ kind: 'exclusive' });
    expect(retire(f).worktreeWrites()).toBe(writes);
    expect(f.worktrees[0].deletion_started_at).toBe(started);
  });

  it.each([
    ['malformed', { version: 2 } as never],
    ['empty', { version: 1, sessions: [] } as never],
    [
      'multi-member',
      {
        version: 1,
        sessions: [
          { sessionId: kiloId(0), cloudAgentSessionId: cloudId(0) },
          { sessionId: kiloId(1), cloudAgentSessionId: cloudId(1) },
        ],
      } as never,
    ],
  ])('C1 negative: a %s manifest never authorizes a stop', async (_name, manifest) => {
    const f = database();
    f.worktrees[0].deletion_started_at = '2026-08-27 02:00:00+00';
    f.worktrees[0].deletion_manifest = manifest;
    await expect(retire(f).call()).resolves.toEqual({ kind: 'unresolved' });
    expect(retire(f).worktreeWrites()).toBe(0);
  });

  it('C1 negative: a completed receipt is unresolved and is not rewritten', async () => {
    const f = database(0);
    f.worktrees[0] = worktree({
      deletion_started_at: '2026-08-27 02:00:00+00',
      deletion_completed_at: '2026-08-27 02:01:00+00',
      name: null,
      deletion_manifest: null,
      deleted_session_ids: [kiloId(0)],
    });
    await expect(retire(f).call()).resolves.toEqual({ kind: 'unresolved' });
    expect(retire(f).worktreeWrites()).toBe(0);
  });

  it.each([cloudId(0), cloudId(1)])(
    'returns shared for the other member row when retiring %s and writes no marker',
    async member => {
      const f = database(2);
      await expect(retire(f).call(member)).resolves.toEqual({ kind: 'shared' });
      expect(f.worktrees[0].deletion_started_at).toBeNull();
      expect(retire(f).worktreeWrites()).toBe(0);
    }
  );

  it('fails closed with unresolved when the worktree has zero members', async () => {
    const f = database(0);
    await expect(retire(f).call()).resolves.toEqual({ kind: 'unresolved' });
    expect(f.worktrees[0].deletion_started_at).toBeNull();
    expect(retire(f).worktreeWrites()).toBe(0);
  });

  it('propagates an owner or organization mismatch as WORKTREE_ACCESS_DENIED', async () => {
    const f = database();
    await expect(
      retireWorktreeIfSoleMember(env, {
        ...params,
        kiloUserId: 'another-user',
        cloudAgentSessionId: cloudId(0),
      })
    ).rejects.toThrow('worktree_access_denied');
    await expect(
      retireWorktreeIfSoleMember(env, {
        ...params,
        organizationId,
        cloudAgentSessionId: cloudId(0),
      })
    ).rejects.toThrow('worktree_access_denied');
    expect(f.worktrees[0].deletion_started_at).toBeNull();
  });

  it('retires a sole root that has a subagent child and journals the child in the manifest', async () => {
    const f = database();
    f.members.push({
      sessionId: kiloId(1),
      cloudAgentSessionId: null,
      cloudAgentSessionScopeId: cloudId(0),
      organizationId: null,
      worktreeId,
      userId,
      parentSessionId: kiloId(0),
    });
    await expect(retire(f).call()).resolves.toEqual({ kind: 'exclusive' });
    expect(f.worktrees[0].deletion_started_at).not.toBeNull();
    expect(
      cloudAgentWorktreeDeletionManifestSchema.parse(f.worktrees[0].deletion_manifest)
    ).toEqual({
      version: 1,
      sessions: [
        { sessionId: kiloId(0), cloudAgentSessionId: cloudId(0) },
        { sessionId: kiloId(1), cloudAgentSessionId: null },
      ],
    });
  });

  it('treats an already-set marker with a root and its child as exclusive', async () => {
    const f = database();
    f.members.push({
      sessionId: kiloId(1),
      cloudAgentSessionId: null,
      cloudAgentSessionScopeId: cloudId(0),
      organizationId: null,
      worktreeId,
      userId,
      parentSessionId: kiloId(0),
    });
    f.worktrees[0].deletion_started_at = '2026-08-27 02:00:00+00';
    f.worktrees[0].deletion_manifest = {
      version: 1,
      sessions: [
        { sessionId: kiloId(0), cloudAgentSessionId: cloudId(0) },
        { sessionId: kiloId(1), cloudAgentSessionId: null },
      ],
    };
    await expect(retire(f).call()).resolves.toEqual({ kind: 'exclusive' });
    expect(retire(f).worktreeWrites()).toBe(0);
  });

  it('returns shared for two root owners and stops neither', async () => {
    const f = database(2);
    await expect(retire(f).call(cloudId(0))).resolves.toEqual({ kind: 'shared' });
    await expect(retire(f).call(cloudId(1))).resolves.toEqual({ kind: 'shared' });
    expect(f.worktrees[0].deletion_started_at).toBeNull();
    expect(retire(f).worktreeWrites()).toBe(0);
  });

  it('returns unresolved and keeps the marker when a second owner appears before the manifest write', async () => {
    const f = database();
    const execute = f.tx.execute;
    let discoveries = 0;
    f.tx.execute = async query => {
      discoveries += 1;
      const result = await execute(query);
      if (discoveries === 1)
        f.members.push({
          sessionId: kiloId(1),
          cloudAgentSessionId: cloudId(1),
          organizationId: null,
          worktreeId,
          userId,
          parentSessionId: null,
        });
      return result;
    };
    await expect(retire(f).call()).resolves.toEqual({ kind: 'unresolved' });
    expect(f.worktrees[0].deletion_started_at).not.toBeNull();
    expect(
      cloudAgentWorktreeDeletionManifestSchema
        .parse(f.worktrees[0].deletion_manifest)
        .sessions.map(session => session.sessionId)
    ).toEqual([kiloId(0), kiloId(1)]);
  });

  it('fails closed with unresolved when the manifest has zero owner rows', async () => {
    const f = database();
    f.worktrees[0].deletion_started_at = '2026-08-27 02:00:00+00';
    f.worktrees[0].deletion_manifest = {
      version: 1,
      sessions: [{ sessionId: kiloId(1), cloudAgentSessionId: null }],
    };
    await expect(retire(f).call()).resolves.toEqual({ kind: 'unresolved' });
    expect(retire(f).worktreeWrites()).toBe(0);
    expect(f.worktrees[0].deletion_started_at).toBe('2026-08-27 02:00:00+00');
  });
});

describe('sole-member begin guard', () => {
  it('rejects a concurrent sibling root before writing the marker or watches', async () => {
    const f = database(2);
    await expect(
      beginWorktreeDeletion(env, { ...params, onlyIfSoleSessionId: kiloId(0) })
    ).rejects.toThrow(WORKTREE_MEMBERSHIP_CHANGED);
    expect(f.worktrees[0].deletion_started_at).toBeNull();
    expect(f.worktrees[0].deletion_manifest).toBeNull();
    expect(f.events).not.toContain('updateWorktree');
    expect(f.events).not.toContain('finishWatches');
  });

  it('rejects when the requested session is not the sole root', async () => {
    const f = database();
    await expect(
      beginWorktreeDeletion(env, { ...params, onlyIfSoleSessionId: kiloId(1) })
    ).rejects.toThrow(WORKTREE_MEMBERSHIP_CHANGED);
    expect(f.worktrees[0].deletion_started_at).toBeNull();
    expect(f.worktrees[0].deletion_manifest).toBeNull();
  });

  it('allows descendants of the sole root', async () => {
    database(1, 1);
    await expect(
      beginWorktreeDeletion(env, { ...params, onlyIfSoleSessionId: kiloId(0) })
    ).resolves.toMatchObject({
      completed: false,
      manifest: {
        version: 1,
        sessions: [
          { sessionId: kiloId(0), cloudAgentSessionId: cloudId(0) },
          { sessionId: kiloId(1), cloudAgentSessionId: null },
        ],
      },
    });
  });

  it('checks the committed manifest on replay instead of re-reading membership', async () => {
    const f = database();
    await beginWorktreeDeletion(env, { ...params, onlyIfSoleSessionId: kiloId(0) });
    const manifest = structuredClone(f.worktrees[0].deletion_manifest);
    f.members.push({
      sessionId: kiloId(1),
      cloudAgentSessionId: cloudId(1),
      organizationId: null,
      worktreeId,
      userId,
      parentSessionId: null,
    });
    await expect(
      beginWorktreeDeletion(env, { ...params, onlyIfSoleSessionId: kiloId(0) })
    ).resolves.toMatchObject({ completed: false, manifest });
    await expect(
      beginWorktreeDeletion(env, { ...params, onlyIfSoleSessionId: kiloId(1) })
    ).rejects.toThrow(WORKTREE_MEMBERSHIP_CHANGED);
    expect(f.worktrees[0].deletion_manifest).toEqual(manifest);
  });
});

describe('deleteWorktreeContent', () => {
  it('deletes content and rows but retains the deletion journal and runtime locations', async () => {
    const f = database(2, 1);
    await beginWorktreeDeletion(env, params);
    const manifest = structuredClone(f.worktrees[0].deletion_manifest);
    const sessionIds = [kiloId(0), kiloId(1), kiloId(2)];

    await expect(deleteWorktreeContent(env, params, f.executionContext)).resolves.toEqual({
      success: true,
      deletedSessionIds: sessionIds,
    });
    await Promise.all(f.pendingNotifications);

    expect(f.members).toEqual([]);
    expect(f.cleared).toEqual(new Set(sessionIds));
    expect(f.notifications).toHaveLength(3);
    expect(f.worktrees[0]).toMatchObject({
      deletion_completed_at: null,
      deletion_manifest: manifest,
      runtime_locations: [location],
      deleted_session_ids: sessionIds,
    });
  });

  it('is idempotent and does not duplicate deletion events', async () => {
    const f = database();
    await beginWorktreeDeletion(env, params);
    const first = await deleteWorktreeContent(env, params, f.executionContext);
    await Promise.all(f.pendingNotifications);
    const second = await deleteWorktreeContent(env, params, f.executionContext);
    await Promise.all(f.pendingNotifications);

    expect(second).toEqual(first);
    expect(f.notifications).toHaveLength(1);
    expect(f.worktrees[0].deletion_completed_at).toBeNull();
    expect(f.worktrees[0].deletion_manifest).not.toBeNull();
  });

  it('still tombstones and does not re-notify when complete follows a logical delete', async () => {
    const f = database();
    await beginWorktreeDeletion(env, params);
    const logical = await deleteWorktreeContent(env, params, f.executionContext);
    await Promise.all(f.pendingNotifications);

    await expect(completeWorktreeDeletion(env, params, f.executionContext)).resolves.toEqual(
      logical
    );
    await Promise.all(f.pendingNotifications);

    expect(f.notifications).toHaveLength(1);
    expect(f.worktrees[0]).toMatchObject({
      name: null,
      runtime_locations: [],
      deletion_manifest: null,
      deleted_session_ids: logical.deletedSessionIds,
    });
    expect(f.worktrees[0].deletion_completed_at).not.toBeNull();
  });
});

describe('worktree deletion contract', () => {
  it('exports the membership-changed code and accepts the sole-session precondition', () => {
    expect(WORKTREE_MEMBERSHIP_CHANGED).toBe('worktree_membership_changed');
    expect(
      cloudAgentWorktreeDeletionSchema.parse({
        ...params,
        onlyIfSoleSessionId: kiloId(0),
      })
    ).toEqual({ ...params, onlyIfSoleSessionId: kiloId(0) });
    expect(() =>
      cloudAgentWorktreeDeletionSchema.parse({
        ...params,
        onlyIfSoleSessionId: 'not-a-session-id',
      })
    ).toThrow();
  });
});
