import { hasOrganizationAccess } from '@kilocode/worker-utils';
import { TRPCError } from '@trpc/server';
import { getPgDb } from '../../db/pg.js';
import type { TRPCContext } from '../../types.js';
import { withDORetry } from '../../utils/do-retry.js';
import {
  StartWorktreeCleanupInput,
  WorktreeCleanup,
  WorktreeCleanupScope,
} from '../../worktree-cleanup/schemas.js';
import { getWorktreeCleanupStub } from '../../worktree-cleanup/stub.js';
import { protectedProcedure } from '../auth.js';

async function authorize(ctx: TRPCContext, kilocodeOrganizationId?: string) {
  if (
    ctx.botId !== undefined ||
    (kilocodeOrganizationId &&
      !(await hasOrganizationAccess(getPgDb(ctx.env), {
        kiloUserId: ctx.userId,
        organizationId: kilocodeOrganizationId,
      })))
  ) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Worktree access denied' });
  }
  return { userId: ctx.userId, ...(kilocodeOrganizationId ? { kilocodeOrganizationId } : {}) };
}

export const startWorktreeCleanup = protectedProcedure
  .input(StartWorktreeCleanupInput)
  .output(WorktreeCleanup)
  .mutation(async ({ input, ctx }) => {
    const owner = await authorize(ctx, input.kilocodeOrganizationId);
    return withDORetry(
      () => getWorktreeCleanupStub(ctx.env, owner),
      stub => stub.start(owner, input),
      'startWorktreeCleanup'
    );
  });

export const getWorktreeCleanup = protectedProcedure
  .input(WorktreeCleanupScope)
  .output(WorktreeCleanup.nullable())
  .query(async ({ input, ctx }) => {
    const owner = await authorize(ctx, input.kilocodeOrganizationId);
    return withDORetry(
      () => getWorktreeCleanupStub(ctx.env, owner),
      stub => stub.get(owner),
      'getWorktreeCleanup'
    );
  });
