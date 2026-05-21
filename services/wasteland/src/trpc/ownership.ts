import { TRPCError } from '@trpc/server';
import { getWastelandDOStub } from '../dos/Wasteland.do';
import type { TRPCContext } from './init';

type WastelandOwnershipResult =
  | { type: 'user'; userId: string }
  | { type: 'org'; orgId: string }
  | { type: 'admin' };

export async function resolveWastelandOwnership(
  env: Env,
  ctx: TRPCContext,
  wastelandId: string
): Promise<WastelandOwnershipResult> {
  const stub = getWastelandDOStub(env, wastelandId);
  const config = await stub.getConfig();

  if (!config || config.status === 'deleted') {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Wasteland not found' });
  }

  if (config.owner_type === 'user') {
    if (config.owner_user_id !== ctx.userId) {
      if (ctx.isAdmin) return { type: 'admin' };
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
    return { type: 'user', userId: ctx.userId };
  }

  if (config.owner_type === 'org' && config.organization_id) {
    const membership = ctx.orgMemberships.find(m => m.orgId === config.organization_id);
    if (!membership || membership.role === 'billing_manager') {
      if (ctx.isAdmin) return { type: 'admin' };
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
    return { type: 'org', orgId: config.organization_id };
  }

  if (ctx.isAdmin) return { type: 'admin' };
  throw new TRPCError({ code: 'NOT_FOUND' });
}
