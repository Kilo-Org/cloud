/**
 * Wasteland tRPC router — served directly by the Wasteland worker.
 *
 * Single flat router with all procedures inline, following the Gastown pattern.
 */
/* eslint-disable @typescript-eslint/await-thenable -- DO RPC stubs return Rpc.Promisified which is thenable at runtime */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, procedure, adminProcedure } from './init';
import { resolveWastelandOwnership } from './ownership';
import { getWastelandDOStub } from '../dos/WastelandDO.stub';
import { getWastelandRegistryStub } from '../dos/WastelandRegistry.do';
import { RpcWastelandOutput } from './schemas';
import type { TRPCContext } from './init';
import type { JwtOrgMembership } from '../middleware/auth.middleware';

// ── Helpers ────────────────────────────────────────────────────────────

/** Look up a user's membership for a specific org from the JWT claims. */
function getOrgMembership(
  memberships: JwtOrgMembership[],
  orgId: string
): JwtOrgMembership | undefined {
  return memberships.find(m => m.orgId === orgId);
}

/**
 * Verify the user has org membership that allows wasteland operations.
 * billing_manager role is excluded.
 */
function verifyOrgAccess(ctx: TRPCContext, organizationId: string): JwtOrgMembership {
  const membership = getOrgMembership(ctx.orgMemberships, organizationId);
  if (!membership || membership.role === 'billing_manager') {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Not an org member or insufficient permissions',
    });
  }
  return membership;
}

// ── Router ─────────────────────────────────────────────────────────────

export const wastelandRouter = router({
  // ── Create ──────────────────────────────────────────────────────────

  createWasteland: procedure
    .input(
      z.object({
        name: z.string().min(1).max(128),
        ownerType: z.enum(['user', 'org']),
        organizationId: z.string().uuid().optional(),
        dolthubUpstream: z.string().optional(),
        visibility: z.enum(['public', 'private']).default('private'),
      })
    )
    .output(RpcWastelandOutput)
    .mutation(async ({ ctx, input }) => {
      // Org ownership: verify membership (not billing_manager)
      if (input.ownerType === 'org') {
        if (!input.organizationId) {
          throw new TRPCError({
            code: 'BAD_REQUEST',
            message: 'organizationId is required when ownerType is org',
          });
        }
        verifyOrgAccess(ctx, input.organizationId);
      }

      const wastelandId = crypto.randomUUID();
      const stub = getWastelandDOStub(ctx.env, wastelandId);

      const config = await stub.initializeWasteland({
        wasteland_id: wastelandId,
        name: input.name,
        owner_type: input.ownerType,
        owner_user_id: ctx.userId,
        organization_id: input.organizationId ?? null,
        dolthub_upstream: input.dolthubUpstream ?? null,
        visibility: input.visibility,
      });

      // Register in the central wasteland registry for listing
      const registryStub = getWastelandRegistryStub(ctx.env);
      await registryStub.register({
        wasteland_id: wastelandId,
        owner_type: input.ownerType,
        owner_user_id: ctx.userId,
        organization_id: input.organizationId ?? null,
        name: input.name,
      });

      return config;
    }),

  // ── List ────────────────────────────────────────────────────────────

  listWastelands: procedure
    .input(
      z.object({
        organizationId: z.string().uuid().optional(),
      })
    )
    .output(z.array(RpcWastelandOutput))
    .query(async ({ ctx, input }) => {
      const registryStub = getWastelandRegistryStub(ctx.env);

      const entries = input.organizationId
        ? await registryStub.listByOrg(input.organizationId)
        : await registryStub.listByUser(ctx.userId);

      // If listing org wastelands, verify the user has org membership
      if (input.organizationId) {
        verifyOrgAccess(ctx, input.organizationId);
      }

      // Resolve each wasteland's full config from its DO
      const results = await Promise.all(
        entries.map(async entry => {
          const stub = getWastelandDOStub(ctx.env, entry.wasteland_id);
          const config = await stub.getConfig();
          // Skip deleted or missing wastelands
          if (!config || config.status === 'deleted') return null;
          return config;
        })
      );

      return results.filter((r): r is NonNullable<typeof r> => r !== null);
    }),

  // ── Get ─────────────────────────────────────────────────────────────

  getWasteland: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(RpcWastelandOutput)
    .query(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      const config = await stub.getConfig();
      if (!config) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Wasteland not found' });
      }
      return config;
    }),

  // ── Delete ──────────────────────────────────────────────────────────

  deleteWasteland: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const ownership = await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);

      // For org wastelands, only owners/admins can delete — not regular members
      if (ownership.type === 'org') {
        const membership = getOrgMembership(ctx.orgMemberships, ownership.orgId);
        if (!membership || membership.role !== 'owner') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only org owners can delete wastelands',
          });
        }
      }

      // Soft-delete: mark as deleted in the WastelandDO
      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      await stub.updateConfig({ status: 'deleted' });

      // Remove from the central registry
      const registryStub = getWastelandRegistryStub(ctx.env);
      await registryStub.unregister(input.wastelandId);

      return { success: true };
    }),

  // ── Admin: List All ─────────────────────────────────────────────────

  adminListWastelands: adminProcedure
    .output(z.array(RpcWastelandOutput))
    .query(async ({ ctx }) => {
      const registryStub = getWastelandRegistryStub(ctx.env);
      const entries = await registryStub.listAll();

      const results = await Promise.all(
        entries.map(async entry => {
          const stub = getWastelandDOStub(ctx.env, entry.wasteland_id);
          const config = await stub.getConfig();
          if (!config) return null;
          return config;
        })
      );

      return results.filter((r): r is NonNullable<typeof r> => r !== null);
    }),
});

export type WastelandRouter = typeof wastelandRouter;

/**
 * Wrapped router that nests wastelandRouter under a `wasteland` key.
 * This preserves the `trpc.wasteland.X` call pattern on the frontend,
 * matching the Gastown wrapping convention.
 */
export const wrappedWastelandRouter = router({ wasteland: wastelandRouter });
export type WrappedWastelandRouter = typeof wrappedWastelandRouter;
