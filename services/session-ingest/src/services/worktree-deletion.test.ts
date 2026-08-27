import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  cli_sessions_v2,
  cloud_agent_worktrees,
  organization_memberships,
  operation_ledgers,
  type CloudAgentWorktree,
} from '@kilocode/db/schema';
import {
  cloudAgentWorktreeDeletionManifestSchema,
  type CloudAgentWorktreeDeletionParams,
  type CanDestroyCloudAgentWorktreeSandboxParams,
} from '@kilocode/session-ingest-contracts';
import {
  beginWorktreeDeletion,
  recordWorktreeCleanup,
  completeWorktreeDeletion,
  canDestroyWorktreeSandbox,
  registerCloudAgentWorktree,
} from './worktree-deletion';
import type { Env } from '../env';

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
    created_at: '2026-08-27 01:00:00+00',
    updated_at: '2026-08-27 01:00:00+00',
    deletion_started_at: null,
    deletion_completed_at: null,
    runtime_locations: [location],
    deletion_manifest: null,
    deleted_session_ids: [],
    ...values,
  };
}

type Member = {
  sessionId: string;
  cloudAgentSessionId: string | null;
  cloudAgentSessionScopeId?: string | null;
  organizationId: string | null;
  worktreeId: string | null;
  userId: string;
  parentSessionId: string | null;
};

function database(rootCount = 1, descendantCount = 0) {
  const worktrees: CloudAgentWorktree[] = [worktree()];
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
      organizationId: null,
      worktreeId: null,
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
  let membershipAllowed = true;
  const valuesOf = (condition: SQL | undefined) =>
    condition ? new PgDialect().sqlToQuery(condition).params : [];
  const select = (columns?: Record<string, unknown>) => {
    let table: unknown;
    let condition: SQL | undefined;
    let limit: number | undefined;
    const rows = () => {
      const bound = valuesOf(condition);
      if (table === cloud_agent_worktrees) {
        const id = bound.find(value => typeof value === 'string' && value.startsWith('worktree_'));
        return id
          ? worktrees.filter(row => row.worktree_id === id)
          : worktrees.filter(row => row.deletion_completed_at === null);
      }
      if (table === organization_memberships)
        return membershipAllowed ? [{ id: 'membership' }] : [];
      if (table === operation_ledgers) return allocations;
      if (table === cli_sessions_v2) {
        const querySql = condition ? new PgDialect().sqlToQuery(condition).sql : '';
        if (querySql.includes('"cloud_agent_session_id" is null')) {
          const cursor = bound.find(value => typeof value === 'string' && value.startsWith('ses_'));
          return members
            .filter(
              row =>
                row.userId === userId &&
                row.cloudAgentSessionId === null &&
                row.cloudAgentSessionScopeId == null &&
                row.worktreeId === null &&
                row.parentSessionId === null &&
                (querySql.includes('"organization_id" is null')
                  ? row.organizationId === null
                  : bound.includes(row.organizationId)) &&
                (typeof cursor !== 'string' || row.sessionId > cursor)
            )
            .sort((a, b) => a.sessionId.localeCompare(b.sessionId))
            .slice(0, limit);
        }
        if (columns && 'userId' in columns)
          return members
            .filter(row => row.worktreeId === worktreeId)
            .map(row => ({ userId: row.userId, organizationId: row.organizationId }));
        if (
          columns &&
          'worktreeId' in columns &&
          !bound.some(value => typeof value === 'string' && value.startsWith('ses_'))
        )
          return members.filter(
            row =>
              row.userId === userId &&
              row.parentSessionId === null &&
              row.cloudAgentSessionId !== null
          );
        return members.filter(
          row =>
            row.userId === userId &&
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
      limit: (value: number) => {
        limit = value;
        return query;
      },
      for: async () => {
        events.push(table === cloud_agent_worktrees ? 'lockWorktree' : 'lockRoots');
        return rows();
      },
      then: (resolve: (result: unknown[]) => unknown) => resolve(rows()),
    };
    return query;
  };
  const insert = () => ({
    values: (values: typeof cloud_agent_worktrees.$inferInsert) => ({
      onConflictDoNothing: async () => {
        if (!worktrees.some(row => row.worktree_id === values.worktree_id))
          worktrees.push(worktree({ name: null, runtime_locations: [], ...values }));
      },
    }),
  });
  const update = (table: unknown) => ({
    set: (
      values: Partial<CloudAgentWorktree> & {
        parent_session_id?: string;
        cloud_agent_session_scope_id?: string;
        cloud_agent_worktree_id?: string;
      }
    ) => {
      const query = {
        where: (condition: SQL) => {
          if (table === cli_sessions_v2) {
            for (const row of members.filter(
              member => member.userId === userId && valuesOf(condition).includes(member.sessionId)
            )) {
              row.parentSessionId = values.parent_session_id ?? row.parentSessionId;
              row.cloudAgentSessionScopeId =
                values.cloud_agent_session_scope_id ?? row.cloudAgentSessionScopeId;
              row.worktreeId = values.cloud_agent_worktree_id ?? row.worktreeId;
              if (values.organization_id !== undefined) row.organizationId = values.organization_id;
            }
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
  });
  const remove = () => ({
    where: async (condition: SQL) => {
      const ids = valuesOf(condition);
      events.push('deleteRows');
      for (let index = members.length - 1; index >= 0; index--)
        if (members[index].userId === userId && ids.includes(members[index].sessionId))
          members.splice(index, 1);
    },
  });
  const tx = {
    select,
    insert,
    update,
    delete: remove,
    execute: async (query: SQL) => {
      sqlQueries.push(new PgDialect().sqlToQuery(query));
      const included = new Set(
        members.filter(row => row.worktreeId === worktreeId).map(row => row.sessionId)
      );
      let previousSize = -1;
      while (included.size !== previousSize) {
        previousSize = included.size;
        const scopes = new Set(
          members
            .filter(row => included.has(row.sessionId))
            .map(row => row.cloudAgentSessionId)
            .filter(Boolean)
        );
        for (const row of members) {
          if (
            row.userId === userId &&
            ((row.parentSessionId !== null && included.has(row.parentSessionId)) ||
              (row.cloudAgentSessionScopeId && scopes.has(row.cloudAgentSessionScopeId)))
          )
            included.add(row.sessionId);
        }
      }
      return {
        rows: members
          .filter(row => included.has(row.sessionId))
          .map(
            ({
              sessionId,
              cloudAgentSessionId,
              cloudAgentSessionScopeId,
              organizationId,
              worktreeId,
            }) => ({
              sessionId,
              cloudAgentSessionId,
              cloudAgentSessionScopeId: cloudAgentSessionScopeId ?? null,
              organizationId,
              worktreeId,
            })
          ),
      };
    },
  };
  const db = {
    ...tx,
    transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  };
  mocks.getDb.mockReturnValue(db);
  const cleared = new Set<string>();
  const snapshots = new Map<string, Record<string, unknown>>();
  let failure: string | undefined;
  mocks.ingest.mockImplementation((_env: Env, identity: { sessionId: string }) => ({
    readKiloSdkSessionSnapshot: async () => {
      const info = snapshots.get(identity.sessionId);
      return info
        ? {
            kind: 'value',
            info: {
              slug: 'child',
              projectID: 'project',
              title: 'Never run',
              version: '7.4.20',
              time: { created: 1, updated: 1 },
              ...info,
            },
            byteLength: 100,
          }
        : { kind: 'pending' };
    },
    clearForWorktree: async (_user: string, session: string) => {
      if (failure === session) throw new Error('R2 temporarily unavailable');
      cleared.add(session);
      events.push(`clear:${session}`);
    },
  }));
  mocks.cache.mockReturnValue({ deleteSession: async () => undefined });
  mocks.connection.mockReturnValue({ clearSession: async () => undefined });
  return {
    db,
    tx,
    worktrees,
    members,
    allocations,
    events,
    sqlQueries,
    cleared,
    snapshots,
    denyMembership: () => {
      membershipAllowed = false;
    },
    fail: (id?: string) => {
      failure = id;
    },
  };
}

beforeEach(() => vi.resetAllMocks());

describe('durable worktree deletion journal', () => {
  it('includes a never-run orphan in cold cleanup using retained authoritative root lineage', async () => {
    const f = database();
    f.members.push({
      sessionId: kiloId(1),
      cloudAgentSessionId: null,
      cloudAgentSessionScopeId: null,
      organizationId: null,
      worktreeId: null,
      userId,
      parentSessionId: null,
    });
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
    expect(f.members).toHaveLength(2);
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
  });

  it('recovers an older never-run orphan snapshot after the runtime and creation event are gone', async () => {
    const f = database();
    const directory = `/workspace/owner/worktrees/${worktreeId}`;
    f.members.push({
      sessionId: kiloId(1),
      cloudAgentSessionId: null,
      cloudAgentSessionScopeId: null,
      organizationId: null,
      worktreeId: null,
      userId,
      parentSessionId: null,
    });
    f.snapshots.set(kiloId(1), { id: kiloId(1), parentID: kiloId(0), directory });
    await beginWorktreeDeletion(env, params);
    await recordWorktreeCleanup(env, { ...params, directory });
    await expect(completeWorktreeDeletion(env, params)).resolves.toEqual({
      success: true,
      deletedSessionIds: [kiloId(0), kiloId(1)],
    });
    expect(f.members).toEqual([]);
    expect(f.cleared.has(kiloId(1))).toBe(true);
  });

  it('does not infer snapshot ownership from directory alone or cross owner, organization, or established root scope', async () => {
    const f = database();
    const directory = `/workspace/owner/worktrees/${worktreeId}`;
    for (let index = 1; index <= 8; index++) {
      f.members.push({
        sessionId: kiloId(index),
        cloudAgentSessionId: null,
        cloudAgentSessionScopeId: null,
        organizationId: null,
        worktreeId: null,
        userId,
        parentSessionId: null,
      });
      f.snapshots.set(kiloId(index), { id: kiloId(index), parentID: kiloId(0), directory });
    }
    f.members[2].userId = 'another-owner';
    f.members[3].organizationId = organizationId;
    f.members[4].cloudAgentSessionScopeId = cloudId(9);
    f.members[4].worktreeId = otherWorktreeId;
    f.snapshots.set(kiloId(5), { id: kiloId(5), parentID: kiloId(99), directory });
    f.snapshots.set(kiloId(6), {
      id: kiloId(6),
      parentID: kiloId(0),
      directory: `${directory}/other`,
    });
    f.snapshots.set(kiloId(7), { id: kiloId(99), parentID: kiloId(0), directory });
    f.snapshots.set(kiloId(8), { id: kiloId(8), parentID: kiloId(8), directory });
    await beginWorktreeDeletion(env, params);
    await recordWorktreeCleanup(env, { ...params, directory });
    await completeWorktreeDeletion(env, params);
    expect(f.cleared).toEqual(new Set([kiloId(0), kiloId(1)]));
    expect(f.members.map(row => row.sessionId)).toEqual(
      Array.from({ length: 7 }, (_, index) => kiloId(index + 2))
    );
  });

  it('includes persisted descendants newly reachable through a recovered orphan parent', async () => {
    const f = database();
    const directory = `/workspace/owner/worktrees/${worktreeId}`;
    f.members.push(
      {
        sessionId: kiloId(1),
        cloudAgentSessionId: null,
        cloudAgentSessionScopeId: null,
        organizationId: null,
        worktreeId: null,
        userId,
        parentSessionId: null,
      },
      {
        sessionId: kiloId(2),
        cloudAgentSessionId: null,
        cloudAgentSessionScopeId: null,
        organizationId: null,
        worktreeId: null,
        userId,
        parentSessionId: kiloId(1),
      }
    );
    f.snapshots.set(kiloId(1), { id: kiloId(1), parentID: kiloId(0), directory });
    await beginWorktreeDeletion(env, params);
    await recordWorktreeCleanup(env, { ...params, directory });
    await expect(completeWorktreeDeletion(env, params)).resolves.toEqual({
      success: true,
      deletedSessionIds: [kiloId(0), kiloId(1), kiloId(2)],
    });
    expect(f.members).toEqual([]);
  });

  it('paginates all orphan snapshots and resolves nested lineage independently of row order', async () => {
    const f = database();
    const directory = `/workspace/owner/worktrees/${worktreeId}`;
    for (let index = 1; index <= 205; index++) {
      f.members.push({
        sessionId: kiloId(index),
        cloudAgentSessionId: null,
        cloudAgentSessionScopeId: null,
        organizationId: null,
        worktreeId: null,
        userId,
        parentSessionId: null,
      });
      f.snapshots.set(kiloId(index), {
        id: kiloId(index),
        parentID: kiloId(index === 205 ? 0 : index + 1),
        directory,
      });
    }
    await beginWorktreeDeletion(env, params);
    const recovered = await recordWorktreeCleanup(env, { ...params, directory });
    expect(recovered.manifest.sessions).toHaveLength(206);
    await completeWorktreeDeletion(env, params);
    expect(f.members).toEqual([]);
    expect(f.cleared.size).toBe(206);
  });

  it.each(['worktree', 'scope'])(
    'rejects an established foreign %s reached through a parent pointer',
    async field => {
      const f = database(1, 1);
      if (field === 'worktree') f.members[1].worktreeId = otherWorktreeId;
      else f.members[1].cloudAgentSessionScopeId = cloudId(9);
      await expect(beginWorktreeDeletion(env, params)).rejects.toThrow('worktree_access_denied');
      expect(f.worktrees[0].deletion_started_at).toBeNull();
      expect(f.cleared.size).toBe(0);
    }
  );

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

  it('recovers an ownership-only migrated root from its pre-registration allocation and preserves it on retry', async () => {
    const f = database();
    const originalCloudId = `workspace_${worktreeId.slice('worktree_'.length)}`;
    f.members[0].cloudAgentSessionId = originalCloudId;
    f.worktrees[0].runtime_locations = [];
    f.allocations.push({
      kilo_user_id: userId,
      organization_id: null,
      intent: 'create_cloud',
      resource_key: null,
      canonical_result: {
        cloudAgentSessionId: originalCloudId,
        kiloSessionId: kiloId(0),
        sandboxId: 'ses-canonical-original',
        sandboxProvider: 'vercel',
        initialMessageId: 'msg_original',
      },
    });
    const first = await beginWorktreeDeletion(env, params);
    expect(first.runtimeLocations).toEqual([
      { sandboxId: 'ses-canonical-original', provider: 'vercel' },
    ]);
    expect(f.worktrees[0].deletion_started_at).not.toBeNull();
    const retry = await beginWorktreeDeletion(env, params);
    expect(retry).toEqual(first);
    expect(f.allocations[0].canonical_result.sandboxId).toBe('ses-canonical-original');
  });

  it('recovers an already-fenced ownership-only root when allocation history is available on retry', async () => {
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
    expect((await beginWorktreeDeletion(env, params)).runtimeLocations).toEqual([
      { sandboxId: 'usr-persisted-override', provider: 'cloudflare' },
    ]);
    expect(f.worktrees[0].deletion_started_at).toBe(started);
  });

  it('can recover a sibling-only group from its canonical first allocation after the first chat row is gone', async () => {
    const f = database();
    f.worktrees[0].runtime_locations = [];
    f.allocations.push({
      kilo_user_id: userId,
      organization_id: null,
      intent: 'create_cloud',
      resource_key: null,
      canonical_result: {
        cloudAgentSessionId: `workspace_${worktreeId.slice('worktree_'.length)}`,
        kiloSessionId: kiloId(500),
        sandboxId: 'ses-original-first-chat',
        sandboxProvider: 'vercel',
      },
    });
    expect((await beginWorktreeDeletion(env, params)).runtimeLocations).toEqual([
      { sandboxId: 'ses-original-first-chat', provider: 'vercel' },
    ]);
  });

  it.each(['owner', 'organization', 'provider'])(
    'does not guess an allocation from invalid %s history',
    async field => {
      const f = database();
      const originalCloudId = `workspace_${worktreeId.slice('worktree_'.length)}`;
      f.members[0].cloudAgentSessionId = originalCloudId;
      f.worktrees[0].runtime_locations = [];
      f.allocations.push({
        kilo_user_id: field === 'owner' ? 'unrelated-owner' : userId,
        organization_id: field === 'organization' ? organizationId : null,
        intent: 'create_cloud',
        resource_key: null,
        canonical_result: {
          cloudAgentSessionId: originalCloudId,
          kiloSessionId: kiloId(0),
          sandboxId: 'ses-do-not-touch',
          sandboxProvider: field === 'provider' ? 'unsupported' : 'vercel',
        },
      });
      expect((await beginWorktreeDeletion(env, params)).runtimeLocations).toEqual([]);
      expect(f.worktrees[0].runtime_locations).toEqual([]);
    }
  );

  it('rejects conflicting canonical allocations rather than choosing a physical route', async () => {
    const f = database();
    const originalCloudId = `workspace_${worktreeId.slice('worktree_'.length)}`;
    f.members[0].cloudAgentSessionId = originalCloudId;
    f.worktrees[0].runtime_locations = [];
    for (const sandboxId of ['ses-first', 'ses-conflict'])
      f.allocations.push({
        kilo_user_id: userId,
        organization_id: null,
        intent: 'create_cloud',
        resource_key: null,
        canonical_result: {
          cloudAgentSessionId: originalCloudId,
          kiloSessionId: kiloId(0),
          sandboxId,
          sandboxProvider: 'vercel',
        },
      });
    await expect(beginWorktreeDeletion(env, params)).rejects.toThrow(
      'worktree_runtime_history_unavailable'
    );
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

  it('discovers all roots and descendants without a UI limit or recursion depth cap, and keeps the manifest after rows disappear', async () => {
    const f = database(205, 15);
    const state = await beginWorktreeDeletion(env, params);
    expect(state.manifest.sessions).toHaveLength(220);
    expect(f.events.indexOf('lockWorktree')).toBeLessThan(f.events.indexOf('lockRoots'));
    expect(f.sqlQueries[0].sql).toContain('WITH RECURSIVE');
    expect(f.sqlQueries[0].sql).not.toMatch(/limit|depth\s*</i);
    expect(f.sqlQueries[0].params).toContain(userId);
    f.members.length = 0;
    expect((await beginWorktreeDeletion(env, params)).manifest.sessions).toEqual(
      state.manifest.sessions
    );
  });

  it('lazily creates metadata for existing groups without inventing a name', async () => {
    const f = database();
    f.worktrees.length = 0;
    const state = await beginWorktreeDeletion(env, params);
    expect(state.manifest.sessions).toHaveLength(1);
    expect(f.worktrees[0].kilo_user_id).toBe(userId);
    expect(f.worktrees[0].organization_id).toBeNull();
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
