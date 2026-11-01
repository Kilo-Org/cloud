import { TRPCError } from '@trpc/server';
import { getWastelandDOStub } from '../dos/Wasteland.do';
import type { TRPCContext } from './init';
import { resolveWastelandAccess, type WastelandAccess } from './access';

type WastelandOwnershipResult = Exclude<WastelandAccess, { type: 'denied' }>;

/**
 * Gates every UUID-keyed procedure. The access rule itself is
 * `resolveWastelandAccess`, shared with the address resolver, so the
 * chooser a caller sees and the procedures they can invoke cannot
 * disagree.
 */
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

  const access = resolveWastelandAccess(config, ctx);
  if (access.type === 'denied') {
    throw new TRPCError({ code: access.reason === 'forbidden' ? 'FORBIDDEN' : 'NOT_FOUND' });
  }
  return access;
}
