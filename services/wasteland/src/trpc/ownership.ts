import { TRPCError } from '@trpc/server';
import { getWastelandDOStub } from '../dos/Wasteland.do';
import { emitWorkerAdminDecision } from '../middleware/worker-admin.middleware';
import type { TRPCContext } from './init';

type WastelandOwnershipResult =
  | { type: 'user'; userId: string }
  | { type: 'org'; orgId: string }
  | { type: 'admin' };

async function workerAdminAllows(ctx: TRPCContext, wastelandId: string): Promise<boolean> {
  const decision = await ctx.workerAdmin.decide(`trpc:${ctx.procedurePath}`, {
    kind: 'wasteland',
    id: wastelandId,
  });
  if (
    ctx.workerAdmin.takeDecisionReport(`trpc:${ctx.procedurePath}`, {
      kind: 'wasteland',
      id: wastelandId,
    })
  ) {
    emitWorkerAdminDecision(ctx.env, decision, {
      action: `trpc:${ctx.procedurePath}`,
      userId: ctx.userId || null,
      wastelandId,
      jti: decision.allowed ? decision.jti : null,
      lifetimeSeconds: ctx.legacyClaimLifetimeSeconds,
      delivery: 'trpc',
    });
  }
  if (!decision.allowed && decision.status === 503) {
    throw new TRPCError({
      code: 'SERVICE_UNAVAILABLE',
      message: 'Admin capability validation unavailable',
    });
  }
  return decision.allowed;
}

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
      if (await workerAdminAllows(ctx, wastelandId)) return { type: 'admin' };
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
    return { type: 'user', userId: ctx.userId };
  }

  if (config.owner_type === 'org' && config.organization_id) {
    const membership = ctx.orgMemberships.find(m => m.orgId === config.organization_id);
    if (!membership || membership.role === 'billing_manager') {
      if (await workerAdminAllows(ctx, wastelandId)) return { type: 'admin' };
      throw new TRPCError({ code: 'FORBIDDEN' });
    }
    return { type: 'org', orgId: config.organization_id };
  }

  if (await workerAdminAllows(ctx, wastelandId)) return { type: 'admin' };
  throw new TRPCError({ code: 'NOT_FOUND' });
}
