import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCError } from '@trpc/server';
import type { Env } from '../types.js';
import { StoredWorktreeCleanupItem } from './schemas.js';
import { WorktreeCleanupCoordinator } from './WorktreeCleanupCoordinator.js';
import { getWorktreeCleanupStub } from './stub.js';

const { deletion } = vi.hoisted(() => ({ deletion: vi.fn() }));
vi.mock('../router/handlers/worktree-deletion.js', () => ({ deleteWorktreeResources: deletion }));
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    constructor(
      protected ctx: DurableObjectState,
      protected env: Env
    ) {}
  },
}));

const owner = { userId: 'oauth/google:cleanup-owner' };
const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const otherWorktreeId = 'worktree_22222222-2222-4222-8222-222222222222';
const sessionId = `ses_${'1'.repeat(26)}`;
const childId = `ses_${'2'.repeat(26)}`;

function fixture() {
  const records = new Map<string, unknown>();
  let alarm: number | null = null;
  let failResultWrite = false;
  const storage = {
    get: vi.fn(async (key: string) => structuredClone(records.get(key))),
    put: vi.fn(async (key: string, value: unknown) => {
      if (
        failResultWrite &&
        StoredWorktreeCleanupItem.safeParse(value).data?.status === 'deleted'
      ) {
        failResultWrite = false;
        throw new Error('isolate terminated before result was persisted');
      }
      records.set(key, structuredClone(value));
    }),
    delete: vi.fn(async (key: string) => records.delete(key)),
    list: vi.fn(
      async ({ prefix }: { prefix: string }) =>
        new Map(
          [...records]
            .filter(([key]) => key.startsWith(prefix))
            .sort(([a], [b]) => a.localeCompare(b))
        )
    ),
    setAlarm: vi.fn(async (time: number) => {
      alarm = time;
    }),
    deleteAlarm: vi.fn(async () => {
      alarm = null;
    }),
    transaction: vi.fn(async <T>(operation: (txn: DurableObjectTransaction) => Promise<T>) =>
      operation(storage as unknown as DurableObjectTransaction)
    ),
  };
  const env = { WORKTREE_CLEANUP: {} } as Env;
  const create = () =>
    new WorktreeCleanupCoordinator({ storage } as unknown as DurableObjectState, env);
  return {
    records,
    storage,
    create,
    coordinator: create(),
    alarm: () => alarm,
    interruptResultWrite: () => {
      failResultWrite = true;
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  deletion.mockResolvedValue({ success: true, deletedSessionIds: [sessionId, childId] });
});

describe('WorktreeCleanupCoordinator', () => {
  it('freezes deduplicated IDs, persists before returning, and processes one worktree per alarm', async () => {
    const f = fixture();
    expect(await f.coordinator.get(owner)).toBeNull();
    const batch = await f.coordinator.start(owner, {
      worktreeIds: [worktreeId, otherWorktreeId, worktreeId],
    });
    expect(batch.items.map(item => item.worktreeId)).toEqual([worktreeId, otherWorktreeId]);
    expect(f.alarm()).toBeGreaterThan(Date.now());
    expect(deletion).not.toHaveBeenCalled();
    expect(await f.create().get(owner)).toEqual(batch);
    expect(await f.coordinator.start(owner, { worktreeIds: [otherWorktreeId] })).toEqual(batch);

    await f.create().alarm();
    expect(deletion).toHaveBeenCalledTimes(1);
    expect(deletion).toHaveBeenCalledWith(
      { worktreeId, kilocodeOrganizationId: undefined, requireMergedPullRequests: true },
      { env: expect.any(Object), userId: owner.userId }
    );
    expect((await f.create().get(owner))?.items).toEqual([
      { worktreeId, status: 'deleted', deletedSessionIds: [sessionId, childId], error: null },
      { worktreeId: otherWorktreeId, status: 'pending', deletedSessionIds: [], error: null },
    ]);
    await f.create().alarm();
    expect(deletion).toHaveBeenCalledTimes(2);
    expect(f.alarm()).toBeNull();
    const replacement = await f.coordinator.start(owner, { worktreeIds: [otherWorktreeId] });
    expect(replacement.id).not.toBe(batch.id);
    expect(replacement.items).toHaveLength(1);
  });

  it('keeps starts deduplicated while deletion is in flight and exposes deleting durably', async () => {
    const f = fixture();
    const completed = Promise.withResolvers<{ success: true; deletedSessionIds: string[] }>();
    deletion.mockReturnValue(completed.promise);
    const batch = await f.coordinator.start(owner, { worktreeIds: [worktreeId] });
    const running = f.coordinator.alarm();
    await vi.waitFor(() => expect(deletion).toHaveBeenCalledTimes(1));
    expect(f.alarm()).toBeGreaterThan(Date.now() + 20_000);
    expect(StoredWorktreeCleanupItem.parse(f.records.get('item:0000'))).toMatchObject({
      status: 'deleting',
      attempts: 1,
    });
    expect((await f.coordinator.start(owner, { worktreeIds: [otherWorktreeId] })).id).toBe(
      batch.id
    );
    completed.resolve({ success: true, deletedSessionIds: [sessionId] });
    await running;
    expect((await f.coordinator.get(owner))?.items[0].status).toBe('deleted');
  });

  it('replays an interrupted deletion on a fresh coordinator using its pre-armed alarm', async () => {
    const f = fixture();
    await f.coordinator.start(owner, { worktreeIds: [worktreeId] });
    f.interruptResultWrite();
    await expect(f.coordinator.alarm()).rejects.toThrow('isolate terminated');
    expect(f.alarm()).not.toBeNull();
    expect((await f.create().get(owner))?.items[0].status).toBe('deleting');
    await f.create().alarm();
    expect(deletion).toHaveBeenCalledTimes(2);
    expect((await f.create().get(owner))?.items[0]).toMatchObject({
      status: 'deleted',
      deletedSessionIds: [sessionId, childId],
    });
    expect(f.alarm()).toBeNull();
  });

  it('retries explicit transient failures with backoff and stops after three attempts', async () => {
    const f = fixture();
    deletion.mockRejectedValue(
      new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: 'Worktree deletion is incomplete',
        cause: { retryable: true },
      })
    );
    await f.coordinator.start(owner, { worktreeIds: [worktreeId, otherWorktreeId] });
    await f.create().alarm();
    expect((await f.create().get(owner))?.items[0]).toMatchObject({
      status: 'pending',
      error: expect.stringContaining('retrying automatically'),
    });
    expect(f.alarm()).toBeGreaterThanOrEqual(Date.now() + 4900);
    await f.create().alarm();
    expect(f.alarm()).toBeGreaterThanOrEqual(Date.now() + 9900);
    await f.create().alarm();
    expect(deletion).toHaveBeenCalledTimes(3);
    expect((await f.create().get(owner))?.items[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('stopped after 3 attempts'),
    });
    deletion.mockResolvedValue({ success: true, deletedSessionIds: [sessionId] });
    await f.create().alarm();
    expect((await f.create().get(owner))?.items[1].status).toBe('deleted');
    expect(f.alarm()).toBeNull();
  });

  it('clears the transient error after a successful automatic retry', async () => {
    const f = fixture();
    deletion.mockRejectedValueOnce(
      new TRPCError({ code: 'SERVICE_UNAVAILABLE', message: 'Cleanup service unavailable' })
    );
    await f.coordinator.start(owner, { worktreeIds: [worktreeId] });
    await f.create().alarm();
    expect((await f.create().get(owner))?.items[0]).toMatchObject({
      status: 'pending',
      error: expect.stringContaining('retrying automatically'),
    });
    await f.create().alarm();
    expect((await f.create().get(owner))?.items[0]).toMatchObject({
      status: 'deleted',
      error: null,
      deletedSessionIds: [sessionId, childId],
    });
    expect(f.alarm()).toBeNull();
  });

  it('retries unexpected platform errors only when explicitly transient, within the same bound', async () => {
    const f = fixture();
    deletion.mockRejectedValue(
      Object.assign(new Error('platform error with secret credential'), { retryable: true })
    );
    await f.coordinator.start(owner, { worktreeIds: [worktreeId] });
    await f.create().alarm();
    expect((await f.create().get(owner))?.items[0].status).toBe('pending');
    await f.create().alarm();
    await f.create().alarm();
    expect(deletion).toHaveBeenCalledTimes(3);
    expect((await f.create().get(owner))?.items[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('stopped after 3 attempts'),
    });
    expect(JSON.stringify([...f.records.values()])).not.toContain('secret credential');
    expect(f.alarm()).toBeNull();
  });

  it('fails a queued worktree permanently when it becomes ineligible while another is deleting', async () => {
    const f = fixture();
    await f.coordinator.start(owner, { worktreeIds: [worktreeId, otherWorktreeId] });
    await f.create().alarm();
    deletion.mockRejectedValue(
      new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Worktree now includes an open pull request',
        cause: { error: 'WORKTREE_MERGED_PULL_REQUESTS_REQUIRED', retryable: false },
      })
    );
    await f.create().alarm();
    expect(deletion).toHaveBeenLastCalledWith(
      {
        worktreeId: otherWorktreeId,
        kilocodeOrganizationId: undefined,
        requireMergedPullRequests: true,
      },
      expect.any(Object)
    );
    expect((await f.create().get(owner))?.items.map(item => item.status)).toEqual([
      'deleted',
      'failed',
    ]);
    expect(f.alarm()).toBeNull();
    await f.create().alarm();
    expect(deletion).toHaveBeenCalledTimes(2);
  });

  it.each([
    new TRPCError({ code: 'FORBIDDEN', message: 'Worktree access denied' }),
    new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Worktree runtime history is unavailable; recovery is required',
      cause: { retryable: false },
    }),
    new Error('unexpected error with secret credential'),
  ])('does not retry permanent failures: %s', async error => {
    const f = fixture();
    deletion.mockRejectedValue(error);
    await f.coordinator.start(owner, { worktreeIds: [worktreeId] });
    await f.create().alarm();
    expect((await f.create().get(owner))?.items[0]).toMatchObject({
      status: 'failed',
      error: expect.any(String),
    });
    expect(JSON.stringify([...f.records.values()])).not.toContain('secret credential');
    expect(f.alarm()).toBeNull();
    await f.create().alarm();
    expect(deletion).toHaveBeenCalledTimes(1);
  });

  it('bounds repeated interruptions and advances to the next worktree', async () => {
    const f = fixture();
    await f.coordinator.start(owner, { worktreeIds: [worktreeId, otherWorktreeId] });
    for (let attempt = 0; attempt < 3; attempt++) {
      f.interruptResultWrite();
      await expect(f.create().alarm()).rejects.toThrow('isolate terminated');
    }
    await f.create().alarm();
    expect(deletion).toHaveBeenCalledTimes(3);
    expect((await f.create().get(owner))?.items[0]).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('interrupted after 3 attempts'),
    });
    await f.create().alarm();
    expect((await f.create().get(owner))?.items[1].status).toBe('deleted');
    expect(f.alarm()).toBeNull();
  });

  it('isolates user and organization namespaces and rejects mismatched stored ownership', async () => {
    const names: string[] = [];
    const env = {
      WORKTREE_CLEANUP: {
        getByName: (name: string) => {
          names.push(name);
          return {};
        },
      },
    } as unknown as Env;
    getWorktreeCleanupStub(env, owner);
    getWorktreeCleanupStub(env, { userId: `${owner.userId}:other` });
    getWorktreeCleanupStub(env, {
      ...owner,
      kilocodeOrganizationId: '22222222-2222-4222-8222-222222222222',
    });
    expect(new Set(names).size).toBe(3);
    const f = fixture();
    await f.coordinator.start(owner, { worktreeIds: [worktreeId] });
    await expect(f.coordinator.get({ userId: 'other' })).rejects.toThrow('Worktree access denied');
    await expect(
      f.coordinator.start({ userId: 'other' }, { worktreeIds: [worktreeId] })
    ).rejects.toThrow('Worktree access denied');
    expect(JSON.stringify([...f.records.values()])).not.toContain('authToken');
  });
});
