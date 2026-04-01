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
import { getWastelandDOStub, type WastelandMemberResult } from '../dos/WastelandDO.stub';
import { getWastelandContainerStub } from '../dos/WastelandContainer.do';
import { getWastelandRegistryStub } from '../dos/WastelandRegistry.do';
import { deriveEncryptionKey, encryptToken, decryptToken } from '../util/crypto.util';
import { resolveSecret } from '../util/secret.util';
import { meterEvent } from '../util/billing.util';
import {
  RpcWastelandOutput,
  RpcWastelandMemberOutput,
  RpcWastelandConfigOutput,
  RpcWastelandCredentialStatusOutput,
  RpcWantedItemOutput,
} from './schemas';
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

      meterEvent(ctx.env, {
        event: 'billing.wasteland_created',
        userId: ctx.userId,
        wastelandId,
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

      meterEvent(ctx.env, {
        event: 'billing.wasteland_deleted',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
      });

      return { success: true };
    }),

  // ── Admin: List All ─────────────────────────────────────────────────

  adminListWastelands: adminProcedure.output(z.array(RpcWastelandOutput)).query(async ({ ctx }) => {
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

  // ── Members ─────────────────────────────────────────────────────────

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

      meterEvent(ctx.env, {
        event: 'billing.member_added',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
        value: members.length,
      });

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

      meterEvent(ctx.env, {
        event: 'billing.member_removed',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
      });

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

      meterEvent(ctx.env, {
        event: 'billing.api_operation',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
        label: 'member_update',
      });

      return updated;
    }),

  // ── Config Update ──────────────────────────────────────────────────

  updateWastelandConfig: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        name: z.string().min(1).max(128).optional(),
        visibility: z.enum(['public', 'private']).optional(),
        dolthubUpstream: z.string().optional(),
      })
    )
    .output(RpcWastelandConfigOutput)
    .mutation(async ({ ctx, input }) => {
      // Owner or org admin only
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);

      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      const config = await stub.updateConfig({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.visibility !== undefined ? { visibility: input.visibility } : {}),
        ...(input.dolthubUpstream !== undefined
          ? { dolthub_upstream: input.dolthubUpstream }
          : {}),
      });

      meterEvent(ctx.env, {
        event: 'billing.api_operation',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
        label: 'config_update',
      });

      return config;
    }),

  // ── Credential: Store ──────────────────────────────────────────────

  storeCredential: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        dolthubToken: z.string().min(1),
        dolthubOrg: z.string().min(1),
        rigHandle: z.string().optional(),
      })
    )
    .output(RpcWastelandCredentialStatusOutput)
    .mutation(async ({ ctx, input }) => {
      // Any member can store their own credential
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);

      // Derive encryption key from WASTELAND_ENCRYPTION_KEY secret
      const rawKey = await resolveSecret(ctx.env.WASTELAND_ENCRYPTION_KEY);
      if (!rawKey) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Encryption key unavailable',
        });
      }
      const cryptoKey = await deriveEncryptionKey(rawKey);
      const encryptedToken = await encryptToken(input.dolthubToken, cryptoKey);

      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      const credential = await stub.storeCredential(
        ctx.userId,
        encryptedToken,
        input.dolthubOrg,
        input.rigHandle
      );

      // If the caller is the wasteland owner, inject the token into
      // the container so it's available in the OS environment.
      const config = await stub.getConfig();
      if (config && config.owner_user_id === ctx.userId) {
        const container = getWastelandContainerStub(ctx.env, input.wastelandId);
        await container.setEnvVar('DOLTHUB_TOKEN', input.dolthubToken);
      }

      meterEvent(ctx.env, {
        event: 'billing.credential_stored',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
      });

      return {
        user_id: credential.user_id,
        dolthub_org: credential.dolthub_org,
        rig_handle: credential.rig_handle,
        connected_at: credential.connected_at,
      };
    }),

  // ── Credential: Get Status ─────────────────────────────────────────

  getCredentialStatus: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(RpcWastelandCredentialStatusOutput.nullable())
    .query(async ({ ctx, input }) => {
      // Any member can check their own credential status
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);

      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      const credential = await stub.getCredential(ctx.userId);

      if (!credential) return null;

      // Never expose the encrypted token
      return {
        user_id: credential.user_id,
        dolthub_org: credential.dolthub_org,
        rig_handle: credential.rig_handle,
        connected_at: credential.connected_at,
      };
    }),

  // ── Credential: Delete ─────────────────────────────────────────────

  deleteCredential: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      // Users can only delete their own credentials — no ownership
      // check needed beyond auth (userId comes from the JWT).
      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      await stub.deleteCredential(ctx.userId);

      meterEvent(ctx.env, {
        event: 'billing.credential_deleted',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
      });

      return { success: true };
    }),

  // ── Wanted Board ──────────────────────────────────────────────────

  browseWantedBoard: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(z.array(RpcWantedItemOutput))
    .query(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      return stub.getWantedBoard();
    }),

  refreshWantedBoard: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(z.array(RpcWantedItemOutput))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      return stub.refreshWantedBoard();
    }),

  // ── Wanted Board Mutations ────────────────────────────────────────

  claimWantedItem: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        itemId: z.string().min(1),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);

      const doStub = getWastelandDOStub(ctx.env, input.wastelandId);
      const credential = await doStub.getCredential(ctx.userId);
      if (!credential) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'No DoltHub credential stored — connect DoltHub in settings first',
        });
      }

      const config = await doStub.getConfig();
      if (!config?.dolthub_upstream) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Wasteland has no DoltHub upstream configured',
        });
      }

      const rawKey = await resolveSecret(ctx.env.WASTELAND_ENCRYPTION_KEY);
      if (!rawKey) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Encryption key unavailable' });
      }
      const cryptoKey = await deriveEncryptionKey(rawKey);
      const token = await decryptToken(credential.encrypted_token, cryptoKey);

      const container = getWastelandContainerStub(ctx.env, input.wastelandId);
      const res = await container.fetch(
        new Request('http://container/wl/claim', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', DOLTHUB_TOKEN: token },
          body: JSON.stringify({
            upstream: config.dolthub_upstream,
            itemId: input.itemId,
            userId: ctx.userId,
          }),
        })
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Claim failed: ${body || res.statusText}`,
        });
      }

      // Refresh the wanted board cache after mutation
      await doStub.refreshWantedBoard();

      meterEvent(ctx.env, {
        event: 'billing.api_operation',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
        label: 'claim',
      });

      return { success: true };
    }),

  postWantedItem: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        title: z.string().min(1).max(256),
        description: z.string().min(1).max(4096),
        priority: z.enum(['low', 'medium', 'high']).optional(),
        type: z.enum(['feature', 'bug', 'docs', 'other']).optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);

      const doStub = getWastelandDOStub(ctx.env, input.wastelandId);
      const credential = await doStub.getCredential(ctx.userId);
      if (!credential) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'No DoltHub credential stored — connect DoltHub in settings first',
        });
      }

      const config = await doStub.getConfig();
      if (!config?.dolthub_upstream) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Wasteland has no DoltHub upstream configured',
        });
      }

      const rawKey = await resolveSecret(ctx.env.WASTELAND_ENCRYPTION_KEY);
      if (!rawKey) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Encryption key unavailable' });
      }
      const cryptoKey = await deriveEncryptionKey(rawKey);
      const token = await decryptToken(credential.encrypted_token, cryptoKey);

      const container = getWastelandContainerStub(ctx.env, input.wastelandId);
      const res = await container.fetch(
        new Request('http://container/wl/post', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', DOLTHUB_TOKEN: token },
          body: JSON.stringify({
            upstream: config.dolthub_upstream,
            title: input.title,
            description: input.description,
          }),
        })
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Post failed: ${body || res.statusText}`,
        });
      }

      // Refresh the wanted board cache after mutation
      await doStub.refreshWantedBoard();

      meterEvent(ctx.env, {
        event: 'billing.api_operation',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
        label: 'post',
      });

      return { success: true };
    }),

  markWantedItemDone: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        itemId: z.string().min(1),
        evidence: z.string().url().min(1),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);

      const doStub = getWastelandDOStub(ctx.env, input.wastelandId);
      const credential = await doStub.getCredential(ctx.userId);
      if (!credential) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'No DoltHub credential stored — connect DoltHub in settings first',
        });
      }

      const config = await doStub.getConfig();
      if (!config?.dolthub_upstream) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Wasteland has no DoltHub upstream configured',
        });
      }

      const rawKey = await resolveSecret(ctx.env.WASTELAND_ENCRYPTION_KEY);
      if (!rawKey) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Encryption key unavailable' });
      }
      const cryptoKey = await deriveEncryptionKey(rawKey);
      const token = await decryptToken(credential.encrypted_token, cryptoKey);

      const container = getWastelandContainerStub(ctx.env, input.wastelandId);
      const res = await container.fetch(
        new Request('http://container/wl/done', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', DOLTHUB_TOKEN: token },
          body: JSON.stringify({
            upstream: config.dolthub_upstream,
            itemId: input.itemId,
            evidence: input.evidence,
          }),
        })
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Mark done failed: ${body || res.statusText}`,
        });
      }

      // Refresh the wanted board cache after mutation
      await doStub.refreshWantedBoard();

      meterEvent(ctx.env, {
        event: 'billing.api_operation',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
        label: 'done',
      });

      return { success: true };
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
