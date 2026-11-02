import { TRPCError } from '@trpc/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const getConfig = vi.fn();
vi.mock('../dos/Wasteland.do', () => ({
  getWastelandDOStub: () => ({ getConfig }),
}));
vi.mock('../middleware/worker-admin.middleware', () => ({
  emitWorkerAdminDecision: vi.fn(),
}));

import { resolveWastelandOwnership } from './ownership';
import type { TRPCContext } from './init';

function context(params: {
  userId?: string;
  memberships?: Array<{ orgId: string; role: string }>;
  decision?: { allowed: boolean; status?: number };
}) {
  const decision = {
    allowed: params.decision?.allowed ?? false,
    status: params.decision?.status,
  };
  return {
    env: {} as never,
    userId: params.userId ?? 'user-1',
    orgMemberships: (params.memberships ?? []).map(m => ({
      orgId: m.orgId,
      role: m.role,
      name: 'org',
    })),
    procedurePath: 'wasteland.deleteWasteland',
    workerAdmin: {
      decide: vi.fn(async () => decision),
      takeDecisionReport: () => true,
    },
  } as unknown as TRPCContext;
}

beforeEach(() => getConfig.mockReset());

describe('resolveWastelandOwnership', () => {
  it('returns the personal owner without an admin decision', async () => {
    getConfig.mockResolvedValue({ status: 'active', owner_type: 'user', owner_user_id: 'user-1' });
    const ctx = context({});
    await expect(resolveWastelandOwnership({} as never, ctx, 'w-1')).resolves.toEqual({
      type: 'user',
      userId: 'user-1',
    });
    expect(ctx.workerAdmin.decide).not.toHaveBeenCalled();
  });

  it('allows a non-owner only through an allowed capability decision', async () => {
    getConfig.mockResolvedValue({ status: 'active', owner_type: 'user', owner_user_id: 'user-2' });
    const ctx = context({ decision: { allowed: true } });
    await expect(resolveWastelandOwnership({} as never, ctx, 'w-1')).resolves.toEqual({
      type: 'admin',
    });
    expect(ctx.workerAdmin.decide).toHaveBeenCalledWith('trpc:wasteland.deleteWasteland', {
      kind: 'wasteland',
      id: 'w-1',
    });
  });

  it('rejects a foreign wasteland when the decision is denied', async () => {
    getConfig.mockResolvedValue({ status: 'active', owner_type: 'user', owner_user_id: 'user-2' });
    await expect(
      resolveWastelandOwnership({} as never, context({ decision: { allowed: false } }), 'w-1')
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('fails closed with 503 when capability validation is unavailable', async () => {
    getConfig.mockResolvedValue({ status: 'active', owner_type: 'user', owner_user_id: 'user-2' });
    const error = await resolveWastelandOwnership(
      {} as never,
      context({ decision: { allowed: false, status: 503 } }),
      'w-1'
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(TRPCError);
    expect(error).toMatchObject({ code: 'SERVICE_UNAVAILABLE' });
  });

  it('rejects a deleted wasteland', async () => {
    getConfig.mockResolvedValue({ status: 'deleted', owner_type: 'user', owner_user_id: 'user-1' });
    await expect(resolveWastelandOwnership({} as never, context({}), 'w-1')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
