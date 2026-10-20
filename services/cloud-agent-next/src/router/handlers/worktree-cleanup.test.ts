import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as WorkerUtils from '@kilocode/worker-utils';
import type { TRPCContext } from '../../types.js';
import { router } from '../auth.js';
import { getWorktreeCleanup, startWorktreeCleanup } from './worktree-cleanup.js';

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  getDb: vi.fn(),
  getStub: vi.fn(),
  start: vi.fn(),
  get: vi.fn(),
}));
vi.mock('@kilocode/worker-utils', async importOriginal => ({
  ...(await importOriginal<typeof WorkerUtils>()),
  hasOrganizationAccess: mocks.access,
}));
vi.mock('../../db/pg.js', () => ({ getPgDb: mocks.getDb }));
vi.mock('../../worktree-cleanup/stub.js', () => ({ getWorktreeCleanupStub: mocks.getStub }));

const worktreeId = 'worktree_11111111-1111-4111-8111-111111111111';
const organizationId = '22222222-2222-4222-8222-222222222222';
const batch = {
  id: 'batch',
  createdAt: '2026-10-20T12:00:00.000Z',
  items: [{ worktreeId, status: 'pending', deletedSessionIds: [], error: null }],
};

function fixture(override: Partial<TRPCContext> = {}) {
  const ctx: TRPCContext = {
    userId: 'oauth/google:owner',
    authToken: 'not-persisted',
    request: new Request('https://worker.test'),
    env: {} as never,
    ...override,
  };
  return { ctx, caller: router({ startWorktreeCleanup, getWorktreeCleanup }).createCaller(ctx) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.access.mockResolvedValue(true);
  mocks.getStub.mockReturnValue({ start: mocks.start, get: mocks.get });
  mocks.start.mockResolvedValue(batch);
  mocks.get.mockResolvedValue(null);
});

describe('worktree cleanup endpoints', () => {
  it('passes only authenticated identity and scope to the durable coordinator', async () => {
    const { caller, ctx } = fixture();
    expect(await caller.startWorktreeCleanup({ worktreeIds: [worktreeId] })).toEqual(batch);
    expect(mocks.start).toHaveBeenCalledWith({ userId: ctx.userId }, { worktreeIds: [worktreeId] });
    expect(await caller.getWorktreeCleanup({})).toBeNull();
    expect(mocks.get).toHaveBeenCalledWith({ userId: ctx.userId });
    expect(mocks.access).not.toHaveBeenCalled();
  });

  it.each(['start', 'get'] as const)(
    'rejects bots and unauthenticated callers for %s',
    async operation => {
      for (const override of [{ botId: 'bot' }, { authToken: '' }]) {
        const { caller } = fixture(override);
        const result =
          operation === 'start'
            ? caller.startWorktreeCleanup({ worktreeIds: [worktreeId] })
            : caller.getWorktreeCleanup({});
        await expect(result).rejects.toMatchObject({
          code: override.botId ? 'FORBIDDEN' : 'UNAUTHORIZED',
        });
      }
      expect(mocks.getStub).not.toHaveBeenCalled();
      expect(mocks.access).not.toHaveBeenCalled();
    }
  );

  it.each(['start', 'get'] as const)('reauthorizes organization access on %s', async operation => {
    const { caller, ctx } = fixture();
    const execute = () =>
      operation === 'start'
        ? caller.startWorktreeCleanup({
            worktreeIds: [worktreeId],
            kilocodeOrganizationId: organizationId,
          })
        : caller.getWorktreeCleanup({ kilocodeOrganizationId: organizationId });
    await execute();
    expect(mocks.access).toHaveBeenCalledWith(undefined, {
      kiloUserId: ctx.userId,
      organizationId,
    });
    expect(mocks.getStub).toHaveBeenCalledWith(ctx.env, {
      userId: ctx.userId,
      kilocodeOrganizationId: organizationId,
    });
    mocks.access.mockResolvedValue(false);
    mocks.getStub.mockClear();
    await expect(execute()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect(mocks.getStub).not.toHaveBeenCalled();
  });

  it.each(
    [[], ['invalid'], Array.from({ length: 1001 }, () => worktreeId)].map(worktreeIds => ({
      worktreeIds,
    }))
  )('rejects invalid or oversized frozen IDs', async ({ worktreeIds }) => {
    await expect(
      fixture().caller.startWorktreeCleanup({ worktreeIds: worktreeIds as `worktree_${string}`[] })
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    expect(mocks.getStub).not.toHaveBeenCalled();
  });
});
