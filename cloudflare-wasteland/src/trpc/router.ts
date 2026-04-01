import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, procedure } from './init';
import type { TRPCContext } from './init';
import { resolveWastelandOwnership } from './ownership';
import { getWastelandDOStub, type WastelandMemberResult } from '../dos/WastelandDO.stub';
import { RpcWastelandMemberOutput } from './schemas';

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Verify the caller has owner-level access to the wasteland.
 * Resolves ownership then checks that the caller is:
 *   - the direct user-owner, OR
 *   - an org owner (not just a regular org member), OR
 *   - a site admin.
 * Throws FORBIDDEN if the caller only has member-level org access.
 */
async function requireOwnerAccess(env: Env, ctx: TRPCContext, wastelandId: string) {
  const ownership = await resolveWastelandOwnership(env, ctx, wastelandId);

  if (ownership.type === 'user' || ownership.type === 'admin') {
    return ownership;
  }

  // For org-owned wastelands, resolveWastelandOwnership allows any
  // non-billing_manager org member through. Write operations require
  // org owner role specifically.
  const membership = ctx.orgMemberships.find(m => m.orgId === ownership.orgId);
  if (!membership || membership.role !== 'owner') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Only wasteland owners or org admins can perform this action',
    });
  }

  return ownership;
}

// ── Router ──────────────────────────────────────────────────────────────

export const wastelandRouter = router({
  listMembers: procedure
    .input(z.object({ wastelandId: z.string() }))
    .output(z.array(RpcWastelandMemberOutput))
    .query(async ({ ctx, input }) => {
      // Any member or owner can list members
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      return stub.listMembers();
    }),

  addMember: procedure
    .input(
      z.object({
        wastelandId: z.string(),
        userId: z.string(),
        role: z.enum(['contributor', 'maintainer', 'owner']).optional(),
        trustLevel: z.number().int().min(1).max(3).optional(),
      })
    )
    .output(RpcWastelandMemberOutput)
    .mutation(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);

      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      const memberId = await stub.addMember(
        input.userId,
        input.role ?? 'contributor',
        input.trustLevel ?? 1
      );

      // Fetch the newly created member record to return
      const members: WastelandMemberResult[] = await stub.listMembers();
      const member = members.find(m => m.member_id === memberId);
      if (!member) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to retrieve newly created member',
        });
      }
      return member;
    }),

  removeMember: procedure
    .input(
      z.object({
        wastelandId: z.string(),
        memberId: z.string(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);

      const stub = getWastelandDOStub(ctx.env, input.wastelandId);

      // Owners cannot remove themselves — fetch members to check
      const members: WastelandMemberResult[] = await stub.listMembers();
      const target = members.find(m => m.member_id === input.memberId);
      if (!target) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found' });
      }
      if (target.user_id === ctx.userId && target.role === 'owner') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Owners cannot remove themselves',
        });
      }

      await stub.removeMember(input.memberId);
      return { success: true };
    }),

  updateMember: procedure
    .input(
      z.object({
        wastelandId: z.string(),
        memberId: z.string(),
        role: z.enum(['contributor', 'maintainer', 'owner']).optional(),
        trustLevel: z.number().int().min(1).max(3).optional(),
      })
    )
    .output(RpcWastelandMemberOutput)
    .mutation(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);

      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      const updated = await stub.updateMember(input.memberId, {
        role: input.role,
        trust_level: input.trustLevel,
      });

      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Member not found' });
      }

      return updated;
    }),
});

export type WastelandRouter = typeof wastelandRouter;

export const wrappedWastelandRouter = router({
  wasteland: wastelandRouter,
});

export type WrappedWastelandRouter = typeof wrappedWastelandRouter;
