import type * as DrizzleOrm from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;
    ctx: ExecutionContext;

    constructor(ctx: ExecutionContext, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

vi.mock('drizzle-orm', async importOriginal => {
  const actual = await importOriginal<typeof DrizzleOrm>();
  return {
    ...actual,
    desc: vi.fn(actual.desc),
    gte: vi.fn(actual.gte),
    isNotNull: vi.fn(actual.isNotNull),
    or: vi.fn(actual.or),
  };
});

vi.mock('./dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(),
  CLONE_ITEM_TYPES: ['session', 'message', 'part', 'session_diff'],
}));

vi.mock('./dos/SessionAccessCacheDO', () => ({
  getSessionAccessCacheDO: vi.fn(),
}));
vi.mock('./session-events', () => ({
  mapSessionEventRow: vi.fn(row => ({ id: row.session_id, updatedAt: row.updated_at })),
  notifyUserSessionEvent: vi.fn(),
}));

vi.mock('./services/user-session-admission', () => ({
  canCreateCliSessionForUser: vi.fn(),
  USER_SESSION_ADMISSION_ERROR: 'User session creation is not allowed',
}));

import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2, organization_memberships } from '@kilocode/db/schema';
import {
  decodeKiloSdkMessagesCursor,
  DEFAULT_KILO_SDK_MESSAGE_PAGE_SIZE,
  encodeKiloSdkMessagesCursor,
  MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE,
  messageIdSchema,
  partIdSchema,
  validateKiloSdkMessagesCursor,
} from '@kilocode/session-ingest-contracts';
import { desc, gte, isNotNull, or } from 'drizzle-orm';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { getSessionAccessCacheDO } from './dos/SessionAccessCacheDO';
import { SessionIngestRPC } from './session-ingest-rpc';
import { notifyUserSessionEvent } from './session-events';
import { canCreateCliSessionForUser } from './services/user-session-admission';

const sdkSessionInfoFixture = {
  id: 'ses_12345678901234567890123456',
  slug: 'quiet-forest',
  projectID: 'project-cloud-agent',
  directory: '/workspace/cloud-agent',
  title: 'SDK attach session',
  agent: 'build',
  model: { id: 'anthropic/claude-sonnet-4', providerID: 'openrouter' },
  version: '7.2.52',
  time: { created: 1761000000000, updated: 1761000001000 },
};

const sdkUserMessageFixture = {
  id: 'msg_user_01',
  sessionID: sdkSessionInfoFixture.id,
  role: 'user' as const,
  time: { created: 1761000000100 },
  agent: 'build',
  model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
};
const sdkTextPartFixture = {
  id: 'prt_user_01',
  sessionID: sdkSessionInfoFixture.id,
  messageID: sdkUserMessageFixture.id,
  type: 'text' as const,
  text: 'Attach to this persisted turn',
};
const sdkStoredMessageFixture = { info: sdkUserMessageFixture, parts: [sdkTextPartFixture] };

type MappingRow = {
  kiloSessionId?: string;
  cloudAgentSessionId?: string | null;
  title?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

function makeDbFakes(rows: MappingRow[]) {
  const selectResult = vi.fn(async () => rows);
  const select = {
    from: vi.fn(() => select),
    leftJoin: vi.fn(() => select),
    where: vi.fn(() => select),
    orderBy: vi.fn(() => select),
    limit: vi.fn(() => select),
    then: vi.fn((resolve: (value: unknown) => unknown) => resolve(selectResult())),
  };
  const db = {
    select: vi.fn(() => select),
  };
  return { db, select, selectResult };
}

function makeRpc(db: ReturnType<typeof makeDbFakes>['db']) {
  vi.mocked(getWorkerDb).mockReturnValue(db as never);
  const ctx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
  } as unknown as ConstructorParameters<typeof SessionIngestRPC>[0];
  const env = {
    HYPERDRIVE: { connectionString: 'postgres://test' },
  } as unknown as ConstructorParameters<typeof SessionIngestRPC>[1];
  return new SessionIngestRPC(ctx, env);
}

function makeRootWriteDb(params: {
  created?: Record<string, unknown>;
  existing?: Record<string, unknown>;
}) {
  const values = vi.fn(() => insert);
  const insert = {
    values,
    onConflictDoNothing: vi.fn(() => insert),
    returning: vi.fn(async () => (params.created ? [params.created] : [])),
  };
  const select = {
    from: vi.fn(() => select),
    where: vi.fn(() => select),
    limit: vi.fn(() => select),
    for: vi.fn(async () => (params.existing ? [params.existing] : [])),
  };
  const updateSet = vi.fn((_values: unknown) => update);
  const update = {
    set: updateSet,
    where: vi.fn(() => update),
    returning: vi.fn(async () => (params.existing ? [params.existing] : [])),
  };
  const tx = {
    insert: vi.fn(() => insert),
    select: vi.fn(() => select),
    update: vi.fn(() => update),
  };
  return {
    db: { transaction: vi.fn(async callback => callback(tx)) },
    values,
    updateSet,
  };
}

describe('createSessionForCloudAgent', () => {
  const params = {
    sessionId: 'ses_12345678901234567890123456',
    kiloUserId: 'usr_test',
    cloudAgentSessionId: 'cloud-agent-session-1',
    organizationId: '11111111-1111-4111-8111-111111111111',
    createdOnPlatform: 'cloud-agent',
  };

  beforeEach(() => {
    vi.mocked(canCreateCliSessionForUser).mockReset().mockResolvedValue(true);
  });

  it('creates a root with both Cloud Agent identity columns', async () => {
    const row = {
      session_id: params.sessionId,
      kilo_user_id: params.kiloUserId,
      cloud_agent_session_id: params.cloudAgentSessionId,
      cloud_agent_session_scope_id: params.cloudAgentSessionId,
      organization_id: params.organizationId,
      parent_session_id: null,
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const fake = makeRootWriteDb({ created: row });
    const rpc = makeRpc(fake.db as never);

    await rpc.createSessionForCloudAgent(params);

    expect(fake.values).toHaveBeenCalledWith(
      expect.objectContaining({
        cloud_agent_session_id: params.cloudAgentSessionId,
        cloud_agent_session_scope_id: params.cloudAgentSessionId,
      })
    );
  });

  it('refuses to claim an existing non-Cloud-Agent session as a root', async () => {
    const fake = makeRootWriteDb({
      existing: {
        session_id: params.sessionId,
        kilo_user_id: params.kiloUserId,
        cloud_agent_session_id: null,
        cloud_agent_session_scope_id: null,
        organization_id: null,
        parent_session_id: null,
      },
    });
    const rpc = makeRpc(fake.db as never);

    await expect(rpc.createSessionForCloudAgent(params)).rejects.toThrow(
      'Cloud Agent root session identity conflict'
    );
  });

  it('rejects a blocked or missing user before any session write', async () => {
    const fake = makeRootWriteDb({ created: { session_id: params.sessionId } });
    vi.mocked(canCreateCliSessionForUser).mockResolvedValueOnce(false);
    const rpc = makeRpc(fake.db as never);

    await expect(rpc.createSessionForCloudAgent(params)).rejects.toThrow(
      'User session creation is not allowed'
    );
    expect(fake.values).not.toHaveBeenCalled();
  });

  it('refuses to change the payer organization of an existing root', async () => {
    const fake = makeRootWriteDb({
      existing: {
        session_id: params.sessionId,
        kilo_user_id: params.kiloUserId,
        cloud_agent_session_id: params.cloudAgentSessionId,
        cloud_agent_session_scope_id: params.cloudAgentSessionId,
        organization_id: null,
        parent_session_id: null,
      },
    });
    const rpc = makeRpc(fake.db as never);

    await expect(rpc.createSessionForCloudAgent(params)).rejects.toThrow(
      'Cloud Agent root session identity conflict'
    );
  });

  it('refuses to remove the payer organization of an existing root', async () => {
    const fake = makeRootWriteDb({
      existing: {
        session_id: params.sessionId,
        kilo_user_id: params.kiloUserId,
        cloud_agent_session_id: params.cloudAgentSessionId,
        cloud_agent_session_scope_id: params.cloudAgentSessionId,
        organization_id: params.organizationId,
        parent_session_id: null,
      },
    });
    const rpc = makeRpc(fake.db as never);
    const { organizationId: _organizationId, ...personalParams } = params;

    await expect(rpc.createSessionForCloudAgent(personalParams)).rejects.toThrow(
      'Cloud Agent root session identity conflict'
    );
  });

  it('accepts an idempotent retry with the same payer organization', async () => {
    const existing = {
      session_id: params.sessionId,
      kilo_user_id: params.kiloUserId,
      cloud_agent_session_id: params.cloudAgentSessionId,
      cloud_agent_session_scope_id: params.cloudAgentSessionId,
      organization_id: params.organizationId,
      parent_session_id: null,
    };
    const fake = makeRootWriteDb({ existing });
    const rpc = makeRpc(fake.db as never);

    await expect(rpc.createSessionForCloudAgent(params)).resolves.toEqual({
      status: 'ready',
      clone: { sessionId: params.sessionId, copiedItemCount: 0 },
    });
    expect(fake.values).toHaveBeenCalledTimes(1);
  });

  it('accepts an idempotent retry for a personal root', async () => {
    const { organizationId: _organizationId, ...personalParams } = params;
    const existing = {
      session_id: personalParams.sessionId,
      kilo_user_id: personalParams.kiloUserId,
      cloud_agent_session_id: personalParams.cloudAgentSessionId,
      cloud_agent_session_scope_id: personalParams.cloudAgentSessionId,
      organization_id: null,
      parent_session_id: null,
    };
    const fake = makeRootWriteDb({ existing });
    const rpc = makeRpc(fake.db as never);

    await expect(rpc.createSessionForCloudAgent(personalParams)).resolves.toEqual({
      status: 'ready',
      clone: { sessionId: personalParams.sessionId, copiedItemCount: 0 },
    });
    expect(fake.values).toHaveBeenCalledTimes(1);
  });

  it('persists a normalized git_url on first insert', async () => {
    const row = {
      session_id: params.sessionId,
      kilo_user_id: params.kiloUserId,
      cloud_agent_session_id: params.cloudAgentSessionId,
      cloud_agent_session_scope_id: params.cloudAgentSessionId,
      organization_id: params.organizationId,
      parent_session_id: null,
      git_url: 'https://github.com/acme/repo',
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const fake = makeRootWriteDb({ created: row });
    const rpc = makeRpc(fake.db as never);

    await rpc.createSessionForCloudAgent({ ...params, gitUrl: 'https://github.com/acme/repo.git' });

    expect(fake.values).toHaveBeenCalledWith(
      expect.objectContaining({ git_url: 'https://github.com/acme/repo' })
    );
  });

  it('accepts an identical repository retry without rewriting git_url', async () => {
    const existing = {
      session_id: params.sessionId,
      kilo_user_id: params.kiloUserId,
      cloud_agent_session_id: params.cloudAgentSessionId,
      cloud_agent_session_scope_id: params.cloudAgentSessionId,
      organization_id: params.organizationId,
      parent_session_id: null,
      git_url: 'https://github.com/acme/repo',
    };
    const fake = makeRootWriteDb({ existing });
    const rpc = makeRpc(fake.db as never);

    await expect(
      rpc.createSessionForCloudAgent({ ...params, gitUrl: 'https://github.com/acme/repo.git' })
    ).resolves.toBeUndefined();
    expect(fake.values).toHaveBeenCalledTimes(1);
    const setArg = fake.updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('git_url');
  });

  it('leaves an existing repository unchanged when old workers omit gitUrl', async () => {
    const existing = {
      session_id: params.sessionId,
      kilo_user_id: params.kiloUserId,
      cloud_agent_session_id: params.cloudAgentSessionId,
      cloud_agent_session_scope_id: params.cloudAgentSessionId,
      organization_id: params.organizationId,
      parent_session_id: null,
      git_url: 'https://github.com/acme/repo',
    };
    const fake = makeRootWriteDb({ existing });
    const rpc = makeRpc(fake.db as never);

    await expect(rpc.createSessionForCloudAgent(params)).resolves.toBeUndefined();
    expect(fake.values).toHaveBeenCalledTimes(1);
    const setArg = fake.updateSet.mock.calls[0][0] as Record<string, unknown>;
    expect(setArg).not.toHaveProperty('git_url');
  });

  it('heals a null repository URL to the input URL and invalidates the access cache', async () => {
    const existing = {
      session_id: params.sessionId,
      kilo_user_id: params.kiloUserId,
      cloud_agent_session_id: params.cloudAgentSessionId,
      cloud_agent_session_scope_id: params.cloudAgentSessionId,
      organization_id: params.organizationId,
      parent_session_id: null,
      git_url: null,
      updated_at: '2026-01-01T00:00:00.000Z',
    };
    const fake = makeRootWriteDb({ existing });
    const cacheRemove = vi.fn(async () => undefined);
    vi.mocked(getSessionAccessCacheDO).mockReturnValue({ remove: cacheRemove } as never);
    const rpc = makeRpc(fake.db as never);

    await rpc.createSessionForCloudAgent({ ...params, gitUrl: 'https://github.com/acme/repo.git' });

    expect(fake.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ git_url: 'https://github.com/acme/repo' })
    );
    expect(cacheRemove).toHaveBeenCalledWith(params.sessionId);
    expect(notifyUserSessionEvent).toHaveBeenCalledWith(
      expect.anything(),
      params.kiloUserId,
      expect.objectContaining({ type: 'session.updated' }),
      expect.anything()
    );
  });

  it('rejects a conflicting repository URL', async () => {
    const existing = {
      session_id: params.sessionId,
      kilo_user_id: params.kiloUserId,
      cloud_agent_session_id: params.cloudAgentSessionId,
      cloud_agent_session_scope_id: params.cloudAgentSessionId,
      organization_id: params.organizationId,
      parent_session_id: null,
      git_url: 'https://github.com/acme/repo',
    };
    const fake = makeRootWriteDb({ existing });
    const rpc = makeRpc(fake.db as never);

    await expect(
      rpc.createSessionForCloudAgent({ ...params, gitUrl: 'https://github.com/other/repo' })
    ).rejects.toThrow('Cloud Agent root session identity conflict');
  });
});

describe('createSessionForCloudAgent clone path', () => {
  const sourceSessionId = 'ses_12345678901234567890123456';
  const destinationSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
  const kiloUserId = 'usr_test';
  const organizationId = '11111111-1111-4111-8111-111111111111';

  type CloneItem = {
    itemId: string;
    itemType: string;
    itemData: string;
    itemDataR2Key: string | null;
    ingestedAt: number | null;
  };

  const sourceSessionItem = (): CloneItem => ({
    itemId: 'session',
    itemType: 'session',
    itemData: JSON.stringify({
      id: sourceSessionId,
      slug: 'quiet-forest',
      projectID: 'project-cloud-agent',
      directory: '/workspace/cloud-agent',
      title: 'SDK attach session',
      agent: 'build',
      model: { id: 'anthropic/claude-sonnet-4', providerID: 'openrouter' },
      version: '7.2.52',
      time: { created: 1761000000000, updated: 1761000001000 },
    }),
    itemDataR2Key: null,
    ingestedAt: 1,
  });

  const sourceMessageItem = (): CloneItem => ({
    itemId: 'message/msg_user_01',
    itemType: 'message',
    itemData: JSON.stringify({
      id: 'msg_user_01',
      sessionID: sourceSessionId,
      role: 'user',
      time: { created: 1761000000100 },
      agent: 'build',
      model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
    }),
    itemDataR2Key: null,
    ingestedAt: 2,
  });

  const sourcePartItem = (): CloneItem => ({
    itemId: 'msg_user_01/prt_user_01',
    itemType: 'part',
    itemData: JSON.stringify({
      id: 'prt_user_01',
      sessionID: sourceSessionId,
      messageID: 'msg_user_01',
      type: 'text',
      text: 'Attach to this persisted turn',
    }),
    itemDataR2Key: null,
    ingestedAt: 3,
  });

  function makePagedSourceStub(items: CloneItem[], pageSize: number) {
    const exportCloneBatch = vi.fn(
      async (cursor: { ingestedAt: number | null; id: number } | null, limit: number) => {
        const startIndex = cursor === null ? 0 : cursor.id;
        const page = items.slice(startIndex, startIndex + Math.min(limit, pageSize));
        const lastIndex = startIndex + page.length;
        const done = lastIndex >= items.length;
        const nextCursor = done
          ? null
          : { ingestedAt: items[lastIndex - 1]?.ingestedAt ?? null, id: lastIndex };
        return { rows: page, nextCursor, done, digest: 'page-digest' };
      }
    );
    return { exportCloneBatch };
  }

  function makeDestinationStub() {
    const state = {
      kind: 'empty' as 'empty' | 'in_progress' | 'complete',
      sourceSessionId: null as string | null,
      destinationSessionId: null as string | null,
      nextCursor: null as { ingestedAt: number | null; id: number } | null,
      rollingDigest: '',
      copiedItemCount: 0,
      stagedRows: [] as CloneItem[],
    };

    const inspectCloneStage = vi.fn(() => {
      if (state.kind === 'empty') return { status: 'empty' };
      const sameIdentity =
        state.sourceSessionId === sourceSessionId &&
        state.destinationSessionId === destinationSessionId;
      if (!sameIdentity) {
        return {
          status: 'mismatch',
          storedSourceSessionId: state.sourceSessionId,
          storedDestinationSessionId: state.destinationSessionId,
          storedStage: state.kind === 'complete' ? 'complete' : 'in_progress',
        };
      }
      if (state.kind === 'complete') {
        return {
          status: 'complete',
          sourceSessionId: state.sourceSessionId,
          destinationSessionId: state.destinationSessionId,
        };
      }
      return {
        status: 'in_progress',
        sourceSessionId: state.sourceSessionId,
        destinationSessionId: state.destinationSessionId,
        nextCursor: state.nextCursor,
        rollingDigest: state.rollingDigest,
        copiedItemCount: state.copiedItemCount,
      };
    });

    const stageCloneBatch = vi.fn(
      (params: {
        sourceSessionId: string;
        destinationSessionId: string;
        rows: CloneItem[];
        nextCursor: { ingestedAt: number | null; id: number } | null;
        rollingDigest: string;
        copiedItemCount: number;
      }) => {
        if (state.kind === 'complete') {
          if (
            state.sourceSessionId === params.sourceSessionId &&
            state.destinationSessionId === params.destinationSessionId
          ) {
            return {
              status: 'complete',
              sourceSessionId: params.sourceSessionId,
              destinationSessionId: params.destinationSessionId,
            };
          }
          return {
            status: 'mismatch',
            storedSourceSessionId: state.sourceSessionId,
            storedDestinationSessionId: state.destinationSessionId,
          };
        }
        if (
          state.kind === 'in_progress' &&
          (state.sourceSessionId !== params.sourceSessionId ||
            state.destinationSessionId !== params.destinationSessionId)
        ) {
          return {
            status: 'mismatch',
            storedSourceSessionId: state.sourceSessionId,
            storedDestinationSessionId: state.destinationSessionId,
          };
        }
        state.kind = 'in_progress';
        state.sourceSessionId = params.sourceSessionId;
        state.destinationSessionId = params.destinationSessionId;
        state.nextCursor = params.nextCursor;
        state.rollingDigest = params.rollingDigest;
        state.copiedItemCount = params.copiedItemCount;
        for (const row of params.rows) state.stagedRows.push(row);
        return {
          status: 'staged',
          sourceSessionId: params.sourceSessionId,
          destinationSessionId: params.destinationSessionId,
          nextCursor: params.nextCursor,
          rollingDigest: params.rollingDigest,
          copiedItemCount: params.copiedItemCount,
        };
      }
    );

    const finalizeCloneStage = vi.fn(
      (params: {
        sourceSessionId: string;
        destinationSessionId: string;
        finalDigest: string;
        finalItemCount: number;
      }) => {
        if (state.kind === 'empty') return { status: 'empty' };
        if (
          state.sourceSessionId !== params.sourceSessionId ||
          state.destinationSessionId !== params.destinationSessionId
        ) {
          return {
            status: 'mismatch',
            storedSourceSessionId: state.sourceSessionId,
            storedDestinationSessionId: state.destinationSessionId,
          };
        }
        if (state.kind === 'complete') {
          return {
            status: 'complete',
            sourceSessionId: params.sourceSessionId,
            destinationSessionId: params.destinationSessionId,
          };
        }
        if (
          state.rollingDigest !== params.finalDigest ||
          state.copiedItemCount !== params.finalItemCount
        ) {
          return {
            status: 'digest_mismatch',
            expectedDigest: params.finalDigest,
            actualDigest: state.rollingDigest,
            expectedItemCount: params.finalItemCount,
            actualItemCount: state.copiedItemCount,
          };
        }
        state.kind = 'complete';
        return {
          status: 'complete',
          sourceSessionId: params.sourceSessionId,
          destinationSessionId: params.destinationSessionId,
        };
      }
    );

    const resetCloneStage = vi.fn(async () => {
      state.kind = 'empty';
      state.sourceSessionId = null;
      state.destinationSessionId = null;
      state.nextCursor = null;
      state.rollingDigest = '';
      state.copiedItemCount = 0;
      state.stagedRows = [];
    });

    return {
      stub: { inspectCloneStage, stageCloneBatch, finalizeCloneStage, resetCloneStage },
      state,
    };
  }

  function makeCloneDb(options: {
    sourceRows: Array<{ sessionId: string; organizationId: string | null }>;
    destinationRows?: Array<Record<string, unknown>>;
    created?: Record<string, unknown>;
    existing?: Record<string, unknown>;
    insertError?: Error;
  }) {
    // `leftJoin` distinguishes the source ownership lookup from the destination
    // pre-check read: only the source lookup joins organization_memberships.
    // `from` resets the flag so each query chain starts clean.
    let leftJoined = false;
    const selectResult = vi.fn(async () =>
      leftJoined ? options.sourceRows : (options.destinationRows ?? [])
    );
    const select = {
      from: vi.fn(() => {
        leftJoined = false;
        return select;
      }),
      leftJoin: vi.fn(() => {
        leftJoined = true;
        return select;
      }),
      where: vi.fn(() => select),
      orderBy: vi.fn(() => select),
      limit: vi.fn(() => select),
      then: vi.fn((resolve: (value: unknown) => unknown) => resolve(selectResult())),
    };
    const values = vi.fn(() => insert);
    const insert = {
      values,
      onConflictDoNothing: vi.fn(() => insert),
      returning: vi.fn(async () => {
        if (options.insertError) throw options.insertError;
        return options.created ? [options.created] : [];
      }),
    };
    const txSelect = {
      from: vi.fn(() => txSelect),
      where: vi.fn(() => txSelect),
      limit: vi.fn(() => txSelect),
      for: vi.fn(async () => (options.existing ? [options.existing] : [])),
    };
    const update = {
      set: vi.fn(() => update),
      where: vi.fn(() => update),
      returning: vi.fn(async () => (options.existing ? [options.existing] : [])),
    };
    const tx = {
      insert: vi.fn(() => insert),
      select: vi.fn(() => txSelect),
      update: vi.fn(() => update),
    };
    const db = {
      select: vi.fn(() => select),
      transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => callback(tx)),
    };
    return { db, values, selectResult };
  }

  function makeCloneRpc(options: {
    db: ReturnType<typeof makeCloneDb>['db'];
    sourceStub: { exportCloneBatch: ReturnType<typeof vi.fn> };
    destStub: ReturnType<typeof makeDestinationStub>['stub'];
    r2: {
      get: ReturnType<typeof vi.fn>;
      put: ReturnType<typeof vi.fn>;
      delete?: ReturnType<typeof vi.fn>;
    };
  }) {
    vi.mocked(getWorkerDb).mockReturnValue(options.db as never);
    vi.mocked(getSessionIngestDO).mockImplementation(
      (_env, { sessionId }) =>
        (sessionId === sourceSessionId ? options.sourceStub : options.destStub) as never
    );
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ConstructorParameters<typeof SessionIngestRPC>[0];
    const env = {
      HYPERDRIVE: { connectionString: 'postgres://test' },
      SESSION_INGEST_R2: options.r2,
    } as unknown as ConstructorParameters<typeof SessionIngestRPC>[1];
    return new SessionIngestRPC(ctx, env);
  }

  const cloneParams = (overrides: Record<string, unknown> = {}) => ({
    sessionId: destinationSessionId,
    kiloUserId,
    cloudAgentSessionId: 'cloud-agent-session-clone',
    organizationId,
    createdOnPlatform: 'cloud-agent',
    cloneFromKiloSessionId: sourceSessionId,
    ...overrides,
  });

  const createdRow = {
    session_id: destinationSessionId,
    kilo_user_id: kiloUserId,
    cloud_agent_session_id: 'cloud-agent-session-clone',
    cloud_agent_session_scope_id: 'cloud-agent-session-clone',
    organization_id: organizationId,
    parent_session_id: null,
    updated_at: '2026-01-01T00:00:00.000Z',
  };

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(canCreateCliSessionForUser).mockReset().mockResolvedValue(true);
  });

  it('clones inline session, message, and part rows, rewrites sessionID, and returns ready', async () => {
    const sourceItems = [sourceSessionItem(), sourceMessageItem(), sourcePartItem()];
    const sourceStub = makePagedSourceStub(sourceItems, sourceItems.length);
    const dest = makeDestinationStub();
    const r2 = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const { db } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
      created: createdRow,
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'ready',
      clone: { sessionId: destinationSessionId, copiedItemCount: 3 },
    });

    const stagedSession = dest.state.stagedRows.find(row => row.itemId === 'session');
    expect(stagedSession).toBeDefined();
    expect(JSON.parse(stagedSession!.itemData)).toMatchObject({
      id: destinationSessionId,
      slug: 'quiet-forest',
      directory: '',
    });
    expect(JSON.parse(stagedSession!.itemData)).not.toHaveProperty('path');
    expect(JSON.parse(stagedSession!.itemData)).not.toHaveProperty('parentID');

    const stagedMessage = dest.state.stagedRows.find(row => row.itemId === 'message/msg_user_01');
    expect(JSON.parse(stagedMessage!.itemData)).toMatchObject({
      id: 'msg_user_01',
      sessionID: destinationSessionId,
    });

    const stagedPart = dest.state.stagedRows.find(row => row.itemId === 'msg_user_01/prt_user_01');
    expect(JSON.parse(stagedPart!.itemData)).toMatchObject({
      id: 'prt_user_01',
      messageID: 'msg_user_01',
      sessionID: destinationSessionId,
    });
  });

  it('copies an R2-backed message body to a deterministic destination key', async () => {
    const r2MessageBody = JSON.stringify({
      id: 'msg_r2_01',
      sessionID: sourceSessionId,
      role: 'user',
      time: { created: 1761000000200 },
      agent: 'build',
      model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
    });
    const sourceItems = [
      sourceSessionItem(),
      {
        itemId: 'message/msg_r2_01',
        itemType: 'message',
        itemData: '{}',
        itemDataR2Key: 'items/blob-msg',
        ingestedAt: 2,
      },
    ];
    const sourceStub = makePagedSourceStub(sourceItems, sourceItems.length);
    const dest = makeDestinationStub();
    const put = vi.fn(async () => {});
    const r2 = {
      get: vi.fn(async (key: string) =>
        key === 'items/blob-msg' ? { text: async () => r2MessageBody } : null
      ),
      put,
    };
    const { db } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
      created: createdRow,
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'ready',
      clone: { sessionId: destinationSessionId, copiedItemCount: 2 },
    });

    const destinationKey = `clone/${destinationSessionId}/message/msg_r2_01`;
    expect(put).toHaveBeenCalledWith(
      destinationKey,
      expect.stringContaining(`"sessionID":"${destinationSessionId}"`)
    );
    const stagedMessage = dest.state.stagedRows.find(row => row.itemId === 'message/msg_r2_01');
    expect(stagedMessage).toMatchObject({ itemData: '{}', itemDataR2Key: destinationKey });
  });

  it('rejects with source_access_denied and leaves no row when the source is not owned', async () => {
    const sourceStub = makePagedSourceStub([], 100);
    const dest = makeDestinationStub();
    const r2 = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const { db, values } = makeCloneDb({ sourceRows: [] });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'rejected',
      code: 'source_access_denied',
    });
    expect(values).not.toHaveBeenCalled();
    expect(sourceStub.exportCloneBatch).not.toHaveBeenCalled();
  });

  it('rejects with organization_mismatch when source and destination organizations differ', async () => {
    const sourceStub = makePagedSourceStub([], 100);
    const dest = makeDestinationStub();
    const r2 = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const { db, values } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId: 'other-org' }],
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'rejected',
      code: 'organization_mismatch',
    });
    expect(values).not.toHaveBeenCalled();
    expect(sourceStub.exportCloneBatch).not.toHaveBeenCalled();
  });

  it('rejects with malformed_source_data and resets the destination stage', async () => {
    const sourceItems = [
      sourceSessionItem(),
      {
        itemId: 'message/msg_bad_01',
        itemType: 'message',
        itemData: 'not-json',
        itemDataR2Key: null,
        ingestedAt: 2,
      },
    ];
    const sourceStub = makePagedSourceStub(sourceItems, sourceItems.length);
    const dest = makeDestinationStub();
    const r2 = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const { db, values } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'rejected',
      code: 'malformed_source_data',
    });
    expect(values).not.toHaveBeenCalled();
    expect(dest.stub.resetCloneStage).toHaveBeenCalled();
  });

  it('rejects with missing_source_body and resets the destination stage', async () => {
    const sourceItems = [
      sourceSessionItem(),
      {
        itemId: 'message/msg_r2_missing',
        itemType: 'message',
        itemData: '{}',
        itemDataR2Key: 'items/missing-blob',
        ingestedAt: 2,
      },
    ];
    const sourceStub = makePagedSourceStub(sourceItems, sourceItems.length);
    const dest = makeDestinationStub();
    const r2 = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const { db, values } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'rejected',
      code: 'missing_source_body',
    });
    expect(values).not.toHaveBeenCalled();
    expect(dest.stub.resetCloneStage).toHaveBeenCalled();
  });

  it('rejects with source_digest_changed when the source changes before finalization', async () => {
    let exportCalls = 0;
    const sourceStub = makePagedSourceStub([], 100);
    sourceStub.exportCloneBatch.mockImplementation(
      async (cursor: { ingestedAt: number | null; id: number } | null, limit: number) => {
        exportCalls += 1;
        const items =
          exportCalls === 1 ? [sourceSessionItem(), sourceMessageItem()] : [sourceSessionItem()];
        const startIndex = cursor === null ? 0 : cursor.id;
        const page = items.slice(startIndex, startIndex + limit);
        const lastIndex = startIndex + page.length;
        const done = lastIndex >= items.length;
        const nextCursor = done
          ? null
          : { ingestedAt: items[lastIndex - 1]?.ingestedAt ?? null, id: lastIndex };
        return { rows: page, nextCursor, done, digest: 'page-digest' };
      }
    );
    const dest = makeDestinationStub();
    const r2 = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const { db, values } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'rejected',
      code: 'source_digest_changed',
    });
    expect(values).not.toHaveBeenCalled();
    expect(dest.stub.resetCloneStage).toHaveBeenCalled();
  });

  it('synthesizes a minimal destination session for an empty source and returns ready', async () => {
    const sourceStub = makePagedSourceStub([], 100);
    const dest = makeDestinationStub();
    const r2 = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const { db } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
      created: createdRow,
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams({ title: 'Cloned' }))).resolves.toEqual(
      {
        status: 'ready',
        clone: { sessionId: destinationSessionId, copiedItemCount: 0 },
      }
    );

    const stagedSession = dest.state.stagedRows.find(row => row.itemId === 'session');
    expect(stagedSession).toBeDefined();
    expect(JSON.parse(stagedSession!.itemData)).toMatchObject({
      id: destinationSessionId,
      projectID: 'cloud-agent',
      title: 'Cloned',
      directory: '',
    });
  });

  it('returns in_progress when the request budget is exhausted and resumes on a same-key retry', async () => {
    const items = Array.from({ length: 20 }, (_, index) => ({
      itemId: `message/msg_${String(index).padStart(2, '0')}`,
      itemType: 'message',
      itemData: JSON.stringify({
        id: `msg_${String(index).padStart(2, '0')}`,
        sessionID: sourceSessionId,
        role: 'user',
        time: { created: index },
        agent: 'build',
        model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
      }),
      itemDataR2Key: null,
      ingestedAt: index,
    }));
    const sourceStub = makePagedSourceStub(items, 1);
    const dest = makeDestinationStub();
    const r2 = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const { db } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
      created: createdRow,
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'in_progress',
    });
    expect(dest.state.kind).toBe('in_progress');
    expect(dest.state.copiedItemCount).toBe(16);

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'ready',
      clone: { sessionId: destinationSessionId, copiedItemCount: 20 },
    });
    expect(dest.state.kind).toBe('complete');
  });

  it('rejects a destination identity conflict and leaves the claimed session untouched', async () => {
    const sourceStub = makePagedSourceStub([], 100);
    const dest = makeDestinationStub();
    const r2 = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const { db, values } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
      destinationRows: [
        {
          session_id: destinationSessionId,
          kilo_user_id: kiloUserId,
          cloud_agent_session_id: 'some-other-agent',
          cloud_agent_session_scope_id: 'some-other-agent',
          organization_id: organizationId,
          parent_session_id: null,
        },
      ],
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'rejected',
      code: 'destination_conflict',
    });
    // The claimed session's DO, R2, and row are never touched.
    expect(dest.stub.inspectCloneStage).not.toHaveBeenCalled();
    expect(sourceStub.exportCloneBatch).not.toHaveBeenCalled();
    expect(r2.put).not.toHaveBeenCalled();
    expect(values).not.toHaveBeenCalled();
  });

  it('resets the destination stage and rethrows when the insert fails without committing', async () => {
    const sourceStub = makePagedSourceStub([sourceSessionItem()], 100);
    const dest = makeDestinationStub();
    const r2 = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const { db } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
      insertError: new Error('postgres unavailable'),
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).rejects.toThrow(
      'postgres unavailable'
    );
    expect(dest.stub.resetCloneStage).toHaveBeenCalled();
  });

  it('does not copy excluded item types', async () => {
    const sourceItems = [
      sourceSessionItem(),
      {
        itemId: 'kilo_meta/1',
        itemType: 'kilo_meta',
        itemData: JSON.stringify({ platform: 'cli' }),
        itemDataR2Key: null,
        ingestedAt: 2,
      },
      sourceMessageItem(),
    ];
    const sourceStub = makePagedSourceStub(sourceItems, sourceItems.length);
    const dest = makeDestinationStub();
    const r2 = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const { db } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
      created: createdRow,
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'ready',
      clone: { sessionId: destinationSessionId, copiedItemCount: 2 },
    });
    expect(dest.state.stagedRows.map(row => row.itemType)).toEqual(['session', 'message']);
  });

  it('rejects a resumed clone whose source digest changed since the prior request', async () => {
    const sourceStub = makePagedSourceStub([sourceSessionItem(), sourceMessageItem()], 100);
    const dest = makeDestinationStub();
    dest.state.kind = 'in_progress';
    dest.state.sourceSessionId = sourceSessionId;
    dest.state.destinationSessionId = destinationSessionId;
    dest.state.nextCursor = null;
    dest.state.rollingDigest = 'stale-digest';
    dest.state.copiedItemCount = 2;
    const r2 = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const { db } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'rejected',
      code: 'source_digest_changed',
    });
    expect(dest.stub.resetCloneStage).toHaveBeenCalled();
  });

  it('rejects a complete destination that belongs to another source without resetting it', async () => {
    const sourceStub = makePagedSourceStub([sourceSessionItem()], 100);
    const dest = makeDestinationStub();
    dest.state.kind = 'complete';
    dest.state.sourceSessionId = 'ses_other_000000000000000000000';
    dest.state.destinationSessionId = destinationSessionId;
    const r2 = { get: vi.fn(async () => null), put: vi.fn(async () => {}) };
    const { db, values } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'rejected',
      code: 'destination_conflict',
    });
    expect(dest.stub.resetCloneStage).not.toHaveBeenCalled();
    expect(r2.put).not.toHaveBeenCalled();
    expect(values).not.toHaveBeenCalled();
  });

  it('deletes destination R2 bodies written before a rejection', async () => {
    const r2MessageBody = JSON.stringify({
      id: 'msg_r2_01',
      sessionID: sourceSessionId,
      role: 'user',
      time: { created: 1761000000200 },
      agent: 'build',
      model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
    });
    const sourceItems = [
      sourceSessionItem(),
      {
        itemId: 'message/msg_r2_01',
        itemType: 'message',
        itemData: '{}',
        itemDataR2Key: 'items/blob-msg',
        ingestedAt: 2,
      },
      {
        itemId: 'message/msg_bad_01',
        itemType: 'message',
        itemData: 'not-json',
        itemDataR2Key: null,
        ingestedAt: 3,
      },
    ];
    const sourceStub = makePagedSourceStub(sourceItems, sourceItems.length);
    const dest = makeDestinationStub();
    const put = vi.fn(async () => {});
    const deleteFn = vi.fn(async () => {});
    const r2 = {
      get: vi.fn(async (key: string) =>
        key === 'items/blob-msg' ? { text: async () => r2MessageBody } : null
      ),
      put,
      delete: deleteFn,
    };
    const { db, values } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'rejected',
      code: 'malformed_source_data',
    });
    expect(deleteFn).toHaveBeenCalledWith([`clone/${destinationSessionId}/message/msg_r2_01`]);
    expect(values).not.toHaveBeenCalled();
  });

  it('writes no destination R2 body for a byte-budget overflow row before an in_progress return', async () => {
    const hugeMessageBody = JSON.stringify({
      id: 'msg_huge',
      sessionID: sourceSessionId,
      role: 'user',
      time: { created: 1761000000200 },
      agent: 'build',
      model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
      text: 'x'.repeat(5 * 1024 * 1024),
    });
    const smallMessage = (index: number): CloneItem => ({
      itemId: `message/msg_${String(index).padStart(2, '0')}`,
      itemType: 'message',
      itemData: JSON.stringify({
        id: `msg_${String(index).padStart(2, '0')}`,
        sessionID: sourceSessionId,
        role: 'user',
        time: { created: index },
        agent: 'build',
        model: { providerID: 'openrouter', modelID: 'anthropic/claude-sonnet-4' },
      }),
      itemDataR2Key: null,
      ingestedAt: index,
    });
    const sourceItems = [
      sourceSessionItem(),
      ...Array.from({ length: 30 }, (_, index) => smallMessage(index + 1)),
      {
        itemId: 'message/msg_huge',
        itemType: 'message',
        itemData: '{}',
        itemDataR2Key: 'items/huge-blob',
        ingestedAt: 32,
      },
    ];
    const sourceStub = makePagedSourceStub(sourceItems, 2);
    const dest = makeDestinationStub();
    const put = vi.fn(async () => {});
    const r2 = {
      get: vi.fn(async (key: string) =>
        key === 'items/huge-blob' ? { text: async () => hugeMessageBody } : null
      ),
      put,
    };
    const { db } = makeCloneDb({
      sourceRows: [{ sessionId: sourceSessionId, organizationId }],
      created: createdRow,
    });
    const rpc = makeCloneRpc({ db, sourceStub, destStub: dest.stub, r2 });

    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'in_progress',
    });
    expect(dest.state.kind).toBe('in_progress');
    expect(dest.state.copiedItemCount).toBe(31);
    expect(put).not.toHaveBeenCalledWith(
      `clone/${destinationSessionId}/message/msg_huge`,
      expect.anything()
    );

    // A later reject resets the stage and must leave no orphaned body behind.
    dest.state.rollingDigest = 'stale-digest';
    await expect(rpc.createSessionForCloudAgent(cloneParams())).resolves.toEqual({
      status: 'rejected',
      code: 'source_digest_changed',
    });
    expect(dest.stub.resetCloneStage).toHaveBeenCalled();
    expect(put).not.toHaveBeenCalledWith(
      `clone/${destinationSessionId}/message/msg_huge`,
      expect.anything()
    );
  });
});

describe('deleteSessionForCloudAgent clone rollback', () => {
  const sourceSessionId = 'ses_12345678901234567890123456';
  const destinationSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
  const kiloUserId = 'usr_test';

  function makeDeleteDb(row?: Record<string, unknown>) {
    const deleteFn = vi.fn(() => ({ where: vi.fn(async () => {}) }));
    const selectResult = vi.fn(async () => (row ? [row] : []));
    const select = {
      from: vi.fn(() => select),
      where: vi.fn(() => select),
      limit: vi.fn(() => select),
      then: vi.fn((resolve: (value: unknown) => unknown) => resolve(selectResult())),
    };
    const db = {
      select: vi.fn(() => select),
      delete: deleteFn,
    };
    return { db, selectResult, deleteFn };
  }

  function makeDeleteRpc(options: {
    db: ReturnType<typeof makeDeleteDb>['db'];
    destStub: {
      inspectCloneStage: ReturnType<typeof vi.fn>;
      resetCloneStage: ReturnType<typeof vi.fn>;
    };
  }) {
    vi.mocked(getWorkerDb).mockReturnValue(options.db as never);
    vi.mocked(getSessionIngestDO).mockReturnValue(options.destStub as never);
    const ctx = {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined,
    } as unknown as ConstructorParameters<typeof SessionIngestRPC>[0];
    const env = {
      HYPERDRIVE: { connectionString: 'postgres://test' },
    } as unknown as ConstructorParameters<typeof SessionIngestRPC>[1];
    return new SessionIngestRPC(ctx, env);
  }

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('deletes the row and resets the clone stage only when the clone matches the source', async () => {
    const inspectCloneStage = vi.fn(() => ({
      status: 'complete',
      sourceSessionId,
      destinationSessionId,
    }));
    const resetCloneStage = vi.fn(async () => {});
    const { db, deleteFn } = makeDeleteDb({
      session_id: destinationSessionId,
      kilo_user_id: kiloUserId,
    });
    const rpc = makeDeleteRpc({ db, destStub: { inspectCloneStage, resetCloneStage } });

    await rpc.deleteSessionForCloudAgent({
      sessionId: destinationSessionId,
      kiloUserId,
      cloneSourceSessionId: sourceSessionId,
    });

    expect(inspectCloneStage).toHaveBeenCalledWith({
      sourceSessionId,
      destinationSessionId,
    });
    expect(resetCloneStage).toHaveBeenCalled();
    expect(deleteFn).toHaveBeenCalled();
  });

  it('never clears a destination clone that belongs to another source', async () => {
    const inspectCloneStage = vi.fn(() => ({
      status: 'mismatch',
      storedSourceSessionId: 'ses_other_000000000000000000000',
      storedDestinationSessionId: destinationSessionId,
    }));
    const resetCloneStage = vi.fn(async () => {});
    const { db, deleteFn } = makeDeleteDb({
      session_id: destinationSessionId,
      kilo_user_id: kiloUserId,
    });
    const rpc = makeDeleteRpc({ db, destStub: { inspectCloneStage, resetCloneStage } });

    await rpc.deleteSessionForCloudAgent({
      sessionId: destinationSessionId,
      kiloUserId,
      cloneSourceSessionId: sourceSessionId,
    });

    expect(resetCloneStage).not.toHaveBeenCalled();
    expect(deleteFn).not.toHaveBeenCalled();
  });
});

describe('Kilo SDK persisted identity schemas', () => {
  it('accepts generated message IDs and rejects non-message, slash-bearing, or NUL-bearing IDs', () => {
    expect(messageIdSchema.safeParse('msg_storage').success).toBe(true);
    expect(messageIdSchema.safeParse('other_storage').success).toBe(false);
    expect(messageIdSchema.safeParse('msg_storage/child').success).toBe(false);
    expect(messageIdSchema.safeParse('msg_storage\u0000child').success).toBe(false);
  });

  it('accepts generated part IDs and rejects non-part, slash-bearing, or NUL-bearing IDs', () => {
    expect(partIdSchema.safeParse('prt_storage').success).toBe(true);
    expect(partIdSchema.safeParse('other_storage').success).toBe(false);
    expect(partIdSchema.safeParse('prt_storage/child').success).toBe(false);
    expect(partIdSchema.safeParse('prt_storage\u0000child').success).toBe(false);
  });
});

describe('Kilo SDK message cursor codec', () => {
  it('round-trips the existing opaque base64url wire encoding', () => {
    const cursor = { id: 'msg_user_01', time: 1761000000100 };
    const encoded = encodeKiloSdkMessagesCursor(cursor);

    expect(encoded).toBe('eyJpZCI6Im1zZ191c2VyXzAxIiwidGltZSI6MTc2MTAwMDAwMDEwMH0');
    expect(decodeKiloSdkMessagesCursor(encoded)).toEqual(cursor);
    expect(validateKiloSdkMessagesCursor(encoded)).toBe(true);
  });

  it('rejects malformed, non-message, and non-strict cursor payloads', () => {
    const encodeUnchecked = (value: unknown) =>
      btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');

    expect(validateKiloSdkMessagesCursor('not-valid')).toBe(false);
    expect(validateKiloSdkMessagesCursor(encodeUnchecked({ id: 'other_01', time: 1 }))).toBe(false);
    expect(
      validateKiloSdkMessagesCursor(encodeUnchecked({ id: 'msg_parent/child', time: 1 }))
    ).toBe(false);
    expect(
      validateKiloSdkMessagesCursor(encodeUnchecked({ id: 'msg_parent\u0000child', time: 1 }))
    ).toBe(false);
    expect(
      validateKiloSdkMessagesCursor(encodeUnchecked({ id: 'msg_user_01', time: 1, extra: true }))
    ).toBe(false);
    expect(validateKiloSdkMessagesCursor(encodeUnchecked({ id: 'msg_user_01', time: -1 }))).toBe(
      false
    );
    expect(
      validateKiloSdkMessagesCursor(encodeUnchecked({ version: 2, beforeMessageId: 'msg_user_01' }))
    ).toBe(false);
    expect(() =>
      decodeKiloSdkMessagesCursor(encodeUnchecked({ id: 'other_01', time: 1 }))
    ).toThrow();
  });
});

describe('SessionIngestRPC.resolveCloudAgentRootSessionForKiloSession', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the Cloud Agent session ID for an owned root Kilo session mapping', async () => {
    const { db, select } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    const rpc = makeRpc(db);

    const result = await rpc.resolveCloudAgentRootSessionForKiloSession({
      kiloUserId: 'usr_owner',
      kiloSessionId: 'ses_12345678901234567890123456',
    });

    expect(result).toEqual({ cloudAgentSessionId: 'agent_owned_root' });
    expect(db.select).toHaveBeenCalledWith({ cloudAgentSessionId: expect.anything() });
    expect(select.leftJoin).toHaveBeenCalledWith(organization_memberships, expect.anything());
    expect(or).toHaveBeenCalled();
  });

  it('returns null when no owned Cloud Agent root mapping is found', async () => {
    const { db } = makeDbFakes([]);
    const rpc = makeRpc(db);

    const result = await rpc.resolveCloudAgentRootSessionForKiloSession({
      kiloUserId: 'usr_owner',
      kiloSessionId: 'ses_12345678901234567890123456',
    });

    expect(result).toBeNull();
  });

  it('returns null when the selected row has no Cloud Agent mapping', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: null }]);
    const rpc = makeRpc(db);

    const result = await rpc.resolveCloudAgentRootSessionForKiloSession({
      kiloUserId: 'usr_owner',
      kiloSessionId: 'ses_12345678901234567890123456',
    });

    expect(result).toBeNull();
  });

  it('rejects invalid Kilo session IDs before querying the database', async () => {
    const { db } = makeDbFakes([]);
    const rpc = makeRpc(db);

    await expect(
      rpc.resolveCloudAgentRootSessionForKiloSession({
        kiloUserId: 'usr_owner',
        kiloSessionId: 'not-a-session',
      })
    ).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('SessionIngestRPC.getCloudAgentRootSessionSnapshot', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns a materialized SDK snapshot only for an owned root Cloud Agent mapping', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkSessionSnapshot: vi.fn(async () => ({
        kind: 'value',
        info: sdkSessionInfoFixture,
        byteLength: 512,
      })),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionSnapshot({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_owned_root',
      snapshot: { kind: 'value', info: sdkSessionInfoFixture, byteLength: 512 },
    });

    const { db: missingDb } = makeDbFakes([]);
    const missingRpc = makeRpc(missingDb);
    await expect(
      missingRpc.getCloudAgentRootSessionSnapshot({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toBeNull();
  });

  it('preserves explicit bounded and pending outcomes for an authorized root', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_pending_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkSessionSnapshot: vi
        .fn()
        .mockResolvedValueOnce({ kind: 'pending' })
        .mockResolvedValueOnce({ kind: 'too_large', maximumBytes: 8 * 1024 * 1024 })
        .mockResolvedValueOnce({ kind: 'retryable_failure' }),
    } as never);
    const rpc = makeRpc(db);

    for (const snapshot of [
      { kind: 'pending' },
      { kind: 'too_large', maximumBytes: 8 * 1024 * 1024 },
      { kind: 'retryable_failure' },
    ]) {
      await expect(
        rpc.getCloudAgentRootSessionSnapshot({
          kiloUserId: 'usr_owner',
          kiloSessionId: sdkSessionInfoFixture.id,
        })
      ).resolves.toEqual({
        kiloSessionId: sdkSessionInfoFixture.id,
        cloudAgentSessionId: 'agent_pending_root',
        snapshot,
      });
    }
  });

  it('returns invalid_data when a persisted snapshot is outside the strict outward contract', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_invalid_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkSessionSnapshot: vi.fn(async () => ({
        kind: 'value',
        info: { ...sdkSessionInfoFixture, time: { created: 'invalid', updated: 1761000001000 } },
        byteLength: 512,
      })),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionSnapshot({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_invalid_root',
      snapshot: { kind: 'invalid_data' },
    });
  });

  it('does not convert snapshot DO failures into invalid_data', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_failed_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkSessionSnapshot: vi.fn(async () => {
        throw new Error('snapshot unavailable');
      }),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionSnapshot({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).rejects.toThrow('snapshot unavailable');
  });
});

describe('SessionIngestRPC.getCloudAgentRootSessionMessages', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns null for an unavailable root and distinguishes pending from empty materialized history', async () => {
    const { db: missingDb } = makeDbFakes([]);
    const missingRpc = makeRpc(missingDb);
    await expect(
      missingRpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toBeNull();

    const { db: ownedDb } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi
        .fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ messages: [], nextCursor: null }),
    } as never);
    const ownedRpc = makeRpc(ownedDb);

    await expect(
      ownedRpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_owned_root',
      history: null,
    });
    await expect(
      ownedRpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_owned_root',
      history: { messages: [], nextCursor: null, omittedItemCount: 0 },
    });
  });

  it('returns full materialized history for native limit zero requests', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    const readKiloSdkMessages = vi.fn(async () => ({
      messages: [sdkStoredMessageFixture],
      nextCursor: null,
    }));
    vi.mocked(getSessionIngestDO).mockReturnValue({ readKiloSdkMessages } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: 0,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_owned_root',
      history: { messages: [sdkStoredMessageFixture], nextCursor: null, omittedItemCount: 0 },
    });
    expect(readKiloSdkMessages).toHaveBeenCalledWith({ limit: 0, before: undefined });
  });

  it('normalizes legacy history pages without omission metadata to zero', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => ({ messages: [], nextCursor: null })),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toMatchObject({
      history: { messages: [], nextCursor: null, omittedItemCount: 0 },
    });
  });

  it('returns exact persisted SDK message history and forwards native paging input', async () => {
    const cursor = 'eyJpZCI6Im1zZ191c2VyXzAxIiwidGltZSI6MTc2MTAwMDAwMDEwMH0';
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    const readKiloSdkMessages = vi.fn(async () => ({
      messages: [sdkStoredMessageFixture],
      nextCursor: cursor,
      omittedItemCount: 3,
    }));
    vi.mocked(getSessionIngestDO).mockReturnValue({ readKiloSdkMessages } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: 2,
        before: cursor,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_owned_root',
      history: { messages: [sdkStoredMessageFixture], nextCursor: cursor, omittedItemCount: 3 },
    });
    expect(readKiloSdkMessages).toHaveBeenCalledWith({ limit: 2, before: cursor });
  });

  it('omits identity-valid future parts from persisted history and reports the omission', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => ({
        messages: [
          {
            info: sdkUserMessageFixture,
            parts: [
              sdkTextPartFixture,
              {
                id: 'prt_future_01',
                sessionID: sdkSessionInfoFixture.id,
                messageID: sdkUserMessageFixture.id,
                type: 'future-safe-part',
                payload: { value: 'new CLI field' },
              },
            ],
          },
        ],
        nextCursor: null,
        omittedItemCount: 3,
      })),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_owned_root',
      history: {
        messages: [sdkStoredMessageFixture],
        nextCursor: null,
        omittedItemCount: 4,
      },
    });
  });

  it('returns invalid_data for future parts with malformed persisted identities', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => ({
        messages: [
          {
            info: sdkUserMessageFixture,
            parts: [
              {
                id: 'other_future_01',
                sessionID: sdkSessionInfoFixture.id,
                messageID: sdkUserMessageFixture.id,
                type: 'future-safe-part',
              },
            ],
          },
        ],
        nextCursor: null,
      })),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_owned_root',
      history: { kind: 'invalid_data' },
    });
  });

  it('strips additive fields from recognized persisted parts', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => ({
        messages: [
          {
            info: sdkUserMessageFixture,
            parts: [{ ...sdkTextPartFixture, futureField: 'not-yet-reviewed' }],
          },
        ],
        nextCursor: null,
      })),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_owned_root',
      history: { messages: [sdkStoredMessageFixture], nextCursor: null, omittedItemCount: 0 },
    });
  });

  it('omits legacy before/after summary diffs while preserving current patch diffs for public projection', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    const currentDiff = {
      file: '/workspace/private/current.ts',
      patch: '@@ -1 +1 @@',
      additions: 1,
      deletions: 1,
    };
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => ({
        messages: [
          {
            info: {
              ...sdkUserMessageFixture,
              summary: {
                title: 'Persisted summary',
                diffs: [
                  {
                    file: '/workspace/private/historical.ts',
                    before: 'const value = 1;',
                    after: 'const value = 2;',
                    additions: 1,
                    deletions: 1,
                  },
                  currentDiff,
                ],
              },
            },
            parts: [sdkTextPartFixture],
          },
        ],
        nextCursor: null,
      })),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_owned_root',
      history: {
        messages: [
          {
            info: {
              ...sdkUserMessageFixture,
              summary: { title: 'Persisted summary', diffs: [currentDiff] },
            },
            parts: [sdkTextPartFixture],
          },
        ],
        nextCursor: null,
        omittedItemCount: 0,
      },
    });
  });

  it('returns invalid_data for ambiguous summary diffs instead of silently discarding current patch detail', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => ({
        messages: [
          {
            info: {
              ...sdkUserMessageFixture,
              summary: {
                diffs: [
                  {
                    file: '/workspace/private/ambiguous.ts',
                    patch: '@@ -1 +1 @@',
                    before: 'const value = 1;',
                    after: 'const value = 2;',
                    additions: 1,
                    deletions: 1,
                  },
                ],
              },
            },
            parts: [sdkTextPartFixture],
          },
        ],
        nextCursor: null,
      })),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_owned_root',
      history: { kind: 'invalid_data' },
    });
  });

  it('returns invalid_data for malformed historical summary diffs instead of silently dropping them', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => ({
        messages: [
          {
            info: {
              ...sdkUserMessageFixture,
              summary: {
                diffs: [
                  {
                    file: '/workspace/private/historical.ts',
                    before: 1,
                    after: 'const value = 2;',
                    additions: 1,
                    deletions: 1,
                  },
                ],
              },
            },
            parts: [sdkTextPartFixture],
          },
        ],
        nextCursor: null,
      })),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_owned_root',
      history: { kind: 'invalid_data' },
    });
  });

  it('does not convert transcript DO failures into invalid_data', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_failed_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => {
        throw new Error('transcript unavailable');
      }),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).rejects.toThrow('transcript unavailable');
  });

  it('preserves a retryable history outcome for facade error mapping', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => ({
        kind: 'retryable_failure',
        phase: 'page_parts',
      })),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: 1,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_owned_root',
      history: { kind: 'retryable_failure', phase: 'page_parts' },
    });
  });

  it('preserves a durable too-large history outcome for facade error mapping', async () => {
    const { db } = makeDbFakes([{ cloudAgentSessionId: 'agent_owned_root' }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => ({
        kind: 'too_large',
        maximumBytes: 8 * 1024 * 1024,
        phase: 'message_scan',
      })),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: 1,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      cloudAgentSessionId: 'agent_owned_root',
      history: {
        kind: 'too_large',
        maximumBytes: 8 * 1024 * 1024,
        phase: 'message_scan',
      },
    });
  });

  it('rejects before without a positive limit and invalid paging input before mapping lookup', async () => {
    const { db } = makeDbFakes([]);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        before: 'not-valid',
      })
    ).rejects.toThrow();
    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: 0,
        before: 'not-valid',
      })
    ).rejects.toThrow();
    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: 2,
        before: 'not-valid',
      })
    ).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects a decodable non-message cursor before mapping lookup', async () => {
    const { db } = makeDbFakes([]);
    const rpc = makeRpc(db);
    const cursor = btoa(JSON.stringify({ id: 'other_01', time: 1 })).replace(/=+$/g, '');

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: 2,
        before: cursor,
      })
    ).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects positive page limits above the shared maximum before mapping lookup', async () => {
    const { db } = makeDbFakes([]);
    const rpc = makeRpc(db);

    await expect(
      rpc.getCloudAgentRootSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE + 1,
      })
    ).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('SessionIngestRPC.listCloudAgentRootSessions', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns mapped root summaries in database order without opening session DOs', async () => {
    const secondSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
    const createdAt = '2026-05-27 20:53:24.190157+00';
    const updatedAt = '2026-05-28 09:13:37.651263+00';
    const { db, select } = makeDbFakes([
      {
        kiloSessionId: secondSessionId,
        cloudAgentSessionId: 'agent_same_time_b',
        title: 'Second',
        createdAt,
        updatedAt,
      },
      {
        kiloSessionId: sdkSessionInfoFixture.id,
        cloudAgentSessionId: 'agent_same_time_a',
        title: 'First',
        createdAt,
        updatedAt,
      },
    ]);
    const rpc = makeRpc(db);

    await expect(
      rpc.listCloudAgentRootSessions({
        kiloUserId: 'usr_owner',
        start: 1761000000000,
        limit: 2,
      })
    ).resolves.toEqual([
      {
        kiloSessionId: secondSessionId,
        cloudAgentSessionId: 'agent_same_time_b',
        title: 'Second',
        created: new Date(createdAt).getTime(),
        updated: new Date(updatedAt).getTime(),
      },
      {
        kiloSessionId: sdkSessionInfoFixture.id,
        cloudAgentSessionId: 'agent_same_time_a',
        title: 'First',
        created: new Date(createdAt).getTime(),
        updated: new Date(updatedAt).getTime(),
      },
    ]);
    expect(getSessionIngestDO).not.toHaveBeenCalled();
    expect(select.leftJoin).toHaveBeenCalledWith(organization_memberships, expect.anything());
    expect(or).toHaveBeenCalled();
    expect(isNotNull).toHaveBeenCalledWith(cli_sessions_v2.cloud_agent_session_id);
    expect(gte).toHaveBeenCalledWith(
      cli_sessions_v2.updated_at,
      new Date(1761000000000).toISOString()
    );
    expect(desc).toHaveBeenNthCalledWith(1, cli_sessions_v2.updated_at);
    expect(desc).toHaveBeenNthCalledWith(2, cli_sessions_v2.session_id);
    expect(select.orderBy).toHaveBeenCalled();
    expect(select.limit).toHaveBeenCalledWith(2);
  });

  it('returns mapped roots without requiring a materialized SDK snapshot and bounds titles', async () => {
    const timestamp = '2026-05-28 09:13:37.651263+00';
    const longTitle = 'x'.repeat(600);
    const { db } = makeDbFakes([
      {
        kiloSessionId: sdkSessionInfoFixture.id,
        cloudAgentSessionId: 'agent_org_root',
        title: longTitle,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]);
    const rpc = makeRpc(db);

    await expect(rpc.listCloudAgentRootSessions({ kiloUserId: 'usr_owner' })).resolves.toEqual([
      {
        kiloSessionId: sdkSessionInfoFixture.id,
        cloudAgentSessionId: 'agent_org_root',
        title: longTitle.slice(0, 512),
        created: new Date(timestamp).getTime(),
        updated: new Date(timestamp).getTime(),
      },
    ]);
    expect(getSessionIngestDO).not.toHaveBeenCalled();
  });

  it('rejects unsafe list bounds before querying root mappings', async () => {
    const { db } = makeDbFakes([]);
    const rpc = makeRpc(db);

    await expect(
      rpc.listCloudAgentRootSessions({ kiloUserId: 'usr_owner', limit: 0 })
    ).rejects.toThrow();
    await expect(
      rpc.listCloudAgentRootSessions({ kiloUserId: 'usr_owner', limit: 101 })
    ).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
  });
});

describe('SessionIngestRPC.getSessionMessages (authorized generic history)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns the bounded latest page for an owned Kilo session with the default limit', async () => {
    const { db } = makeDbFakes([{ kiloSessionId: sdkSessionInfoFixture.id }]);
    const readKiloSdkMessages = vi.fn(async () => ({
      messages: [sdkStoredMessageFixture],
      nextCursor: 'eyJpZCI6Im1zZ191c2VyXzAxIiwidGltZSI6MTc2MTAwMDAwMDEwMH0',
      omittedItemCount: 0,
    }));
    vi.mocked(getSessionIngestDO).mockReturnValue({ readKiloSdkMessages } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getSessionMessages({ kiloUserId: 'usr_owner', kiloSessionId: sdkSessionInfoFixture.id })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      history: {
        messages: [sdkStoredMessageFixture],
        nextCursor: 'eyJpZCI6Im1zZ191c2VyXzAxIiwidGltZSI6MTc2MTAwMDAwMDEwMH0',
        omittedItemCount: 0,
      },
    });
    expect(readKiloSdkMessages).toHaveBeenCalledWith({
      limit: DEFAULT_KILO_SDK_MESSAGE_PAGE_SIZE,
      before: undefined,
    });
  });

  it('defaults omitted limit to the shared page size and pairs it with a continuation cursor', async () => {
    const { db } = makeDbFakes([{ kiloSessionId: sdkSessionInfoFixture.id }]);
    const readKiloSdkMessages = vi.fn(async () => ({
      messages: [sdkStoredMessageFixture],
      nextCursor: null,
      omittedItemCount: 0,
    }));
    vi.mocked(getSessionIngestDO).mockReturnValue({ readKiloSdkMessages } as never);
    const rpc = makeRpc(db);
    const cursor = encodeKiloSdkMessagesCursor({ id: 'msg_user_01', time: 1761000000100 });

    await expect(
      rpc.getSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        before: cursor,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      history: {
        messages: [sdkStoredMessageFixture],
        nextCursor: null,
        omittedItemCount: 0,
      },
    });
    expect(readKiloSdkMessages).toHaveBeenCalledWith({
      limit: DEFAULT_KILO_SDK_MESSAGE_PAGE_SIZE,
      before: cursor,
    });
  });

  it('forwards an explicit limit and a decoded cursor to the DO bounded reader', async () => {
    const { db } = makeDbFakes([{ kiloSessionId: sdkSessionInfoFixture.id }]);
    const readKiloSdkMessages = vi.fn(async () => ({
      messages: [sdkStoredMessageFixture],
      nextCursor: null,
      omittedItemCount: 1,
    }));
    vi.mocked(getSessionIngestDO).mockReturnValue({ readKiloSdkMessages } as never);
    const rpc = makeRpc(db);
    const cursor = encodeKiloSdkMessagesCursor({ id: 'msg_user_01', time: 1761000000100 });

    await expect(
      rpc.getSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: 50,
        before: cursor,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      history: {
        messages: [sdkStoredMessageFixture],
        nextCursor: null,
        omittedItemCount: 1,
      },
    });
    expect(readKiloSdkMessages).toHaveBeenCalledWith({ limit: 50, before: cursor });
  });

  it('returns null when the session is not owned by the requesting user', async () => {
    const { db } = makeDbFakes([]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toBeNull();
    expect(getSessionIngestDO).not.toHaveBeenCalled();
  });

  it('returns null when the org-scoped session has lost its organization membership', async () => {
    const { db } = makeDbFakes([]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toBeNull();
    expect(getSessionIngestDO).not.toHaveBeenCalled();
  });

  it('returns an empty page for a valid session with no persisted messages', async () => {
    const { db } = makeDbFakes([{ kiloSessionId: sdkSessionInfoFixture.id }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => ({
        messages: [],
        nextCursor: null,
        omittedItemCount: 0,
      })),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      history: { messages: [], nextCursor: null, omittedItemCount: 0 },
    });
  });

  it('preserves the durable retryable_failure outcome for bounded requests', async () => {
    const { db } = makeDbFakes([{ kiloSessionId: sdkSessionInfoFixture.id }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => ({
        kind: 'retryable_failure',
        phase: 'message_scan',
      })),
    } as never);
    const rpc = makeRpc(db);

    await expect(
      rpc.getSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: 10,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      history: { kind: 'retryable_failure', phase: 'message_scan' },
    });
  });

  it('preserves the durable too_large and invalid_data outcomes for bounded requests', async () => {
    const { db: dbTooLarge } = makeDbFakes([{ kiloSessionId: sdkSessionInfoFixture.id }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => ({
        kind: 'too_large',
        maximumBytes: 8 * 1024 * 1024,
        phase: 'page_parts',
      })),
    } as never);
    const rpc = makeRpc(dbTooLarge);

    await expect(
      rpc.getSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: 10,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      history: {
        kind: 'too_large',
        maximumBytes: 8 * 1024 * 1024,
        phase: 'page_parts',
      },
    });

    const { db: dbInvalid } = makeDbFakes([{ kiloSessionId: sdkSessionInfoFixture.id }]);
    vi.mocked(getSessionIngestDO).mockReturnValue({
      readKiloSdkMessages: vi.fn(async () => ({ kind: 'invalid_data' })),
    } as never);
    const invalidRpc = makeRpc(dbInvalid);

    await expect(
      invalidRpc.getSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
      })
    ).resolves.toEqual({
      kiloSessionId: sdkSessionInfoFixture.id,
      history: { kind: 'invalid_data' },
    });
  });

  it('rejects invalid Kilo session IDs, missing limits with cursors, and unknown cursors', async () => {
    const { db } = makeDbFakes([]);
    const rpc = makeRpc(db);

    await expect(
      rpc.getSessionMessages({ kiloUserId: 'usr_owner', kiloSessionId: 'not-a-session' })
    ).rejects.toThrow();
    await expect(
      rpc.getSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        before: 'not-valid',
      })
    ).rejects.toThrow();
    await expect(
      rpc.getSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: 0,
        before: 'not-valid',
      })
    ).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects positive limits above the shared maximum before authorizing the request', async () => {
    const { db } = makeDbFakes([]);
    const rpc = makeRpc(db);

    await expect(
      rpc.getSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE + 1,
      })
    ).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
  });

  it('rejects limit=0 (with or without a cursor) before authorizing the request', async () => {
    const { db } = makeDbFakes([]);
    const rpc = makeRpc(db);

    // limit=0 alone — the generic endpoint must always be bounded.
    await expect(
      rpc.getSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: 0,
      })
    ).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();

    // limit=0 with a cursor — same rejection, no DB or DO access.
    await expect(
      rpc.getSessionMessages({
        kiloUserId: 'usr_owner',
        kiloSessionId: sdkSessionInfoFixture.id,
        limit: 0,
        before: 'eyJpZCI6Im1zZ191c2VyXzAxIiwidGltZSI6MTc2MTAwMDAwMDEwMH0',
      })
    ).rejects.toThrow();
    expect(db.select).not.toHaveBeenCalled();
    expect(getSessionIngestDO).not.toHaveBeenCalled();
  });
});
