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
}));

vi.mock('./dos/SessionAccessCacheDO', () => ({
  getSessionAccessCacheDO: vi.fn(),
}));

import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2, organization_memberships } from '@kilocode/db/schema';
import {
  decodeKiloSdkMessagesCursor,
  encodeKiloSdkMessagesCursor,
  MAX_KILO_SDK_MESSAGE_HISTORY_PAGE_SIZE,
  messageIdSchema,
  partIdSchema,
  validateKiloSdkMessagesCursor,
} from '@kilocode/session-ingest-contracts';
import { desc, gte, isNotNull, or } from 'drizzle-orm';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { SessionIngestRPC } from './session-ingest-rpc';

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
  cloudAgentSessionId: string | null;
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
