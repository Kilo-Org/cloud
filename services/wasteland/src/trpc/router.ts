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
import { getWastelandDOStub, type WastelandMemberResult } from '../dos/Wasteland.do';
import { getWastelandContainerStub } from '../dos/WastelandContainer.do';
import { getWastelandRegistryStub } from '../dos/WastelandRegistry.do';
import { deriveEncryptionKey, encryptToken, decryptToken } from '../util/crypto.util';
import { resolveSecret } from '../util/secret.util';
import { meterEvent } from '../util/billing.util';
import * as wantedBoard from '../wanted-board/wanted-board-ops';
import { WantedBoardOpError } from '../wanted-board/wanted-board-ops';
import {
  RpcWastelandOutput,
  RpcWastelandMemberOutput,
  RpcWastelandConfigOutput,
  RpcWastelandCredentialStatusOutput,
  RpcConnectedTownOutput,
  RpcWantedBoardRowOutput,
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

/** Translate a WantedBoardOpError into the matching TRPCError. */
function wantedBoardErrorToTRPC(err: unknown): never {
  if (err instanceof WantedBoardOpError) {
    const code =
      err.code === 'PRECONDITION_FAILED'
        ? 'PRECONDITION_FAILED'
        : err.code === 'NOT_FOUND'
          ? 'NOT_FOUND'
          : 'INTERNAL_SERVER_ERROR';
    throw new TRPCError({ code, message: err.message });
  }
  throw err;
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

      // Auto-register the creator as the wasteland's 'owner' member with
      // maximum trust_level so they can manage members and configuration.
      await stub.addMember(ctx.userId, 'owner', 3);

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

  // ── Create Upstream (invokes `wl create` on the container) ──────────
  // Bootstraps a brand-new DoltHub commons repo with the wasteland schema
  // and registers the caller as the first rig. Requires the caller's
  // credential to already be stored AND marked as upstream-admin. Should
  // only be called as part of the "create your own wasteland" flow after
  // storeCredential has run.
  createUpstream: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        upstream: z.string().min(1), // e.g. "myorg/my-wasteland"
        rigHandle: z.string().optional(),
        rigDisplayName: z.string().optional(),
        rigEmail: z.string().email().optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);

      const doStub = getWastelandDOStub(ctx.env, input.wastelandId);
      const credential = await doStub.getCredential(ctx.userId);
      if (!credential) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Store a DoltHub credential before creating the upstream repo',
        });
      }
      if (!credential.is_upstream_admin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message:
            'Creating a new upstream requires a credential marked as admin. Toggle "I own this upstream" on the stored credential first.',
        });
      }

      const rawKey = await resolveSecret(ctx.env.WASTELAND_ENCRYPTION_KEY);
      if (!rawKey) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Encryption key unavailable',
        });
      }
      const cryptoKey = await deriveEncryptionKey(rawKey);
      const token = await decryptToken(credential.encrypted_token, cryptoKey);

      const config = await doStub.getConfig();
      const displayName = input.rigDisplayName ?? config?.name;

      const container = getWastelandContainerStub(ctx.env, input.wastelandId);
      const res = await container.fetch(
        new Request('http://container/wl/create', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', DOLTHUB_TOKEN: token },
          body: JSON.stringify({
            upstream: input.upstream,
            name: config?.name,
            displayName,
            handle: input.rigHandle ?? credential.rig_handle ?? undefined,
            email: input.rigEmail,
          }),
        })
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `wl create failed: ${body || res.statusText}`,
        });
      }

      // Persist the upstream on the wasteland config now that the repo exists.
      await doStub.updateConfig({ dolthub_upstream: input.upstream });

      meterEvent(ctx.env, {
        event: 'billing.api_operation',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
        label: 'create_upstream',
      });

      return { success: true };
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
        ...(input.dolthubUpstream !== undefined ? { dolthub_upstream: input.dolthubUpstream } : {}),
      });

      // Sync upstream to the container so it's available on next boot
      if (input.dolthubUpstream !== undefined) {
        const container = getWastelandContainerStub(ctx.env, input.wastelandId);
        if (input.dolthubUpstream) {
          await container.setEnvVar('WL_UPSTREAM', input.dolthubUpstream);
        } else {
          await container.deleteEnvVar('WL_UPSTREAM');
        }
      }

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
        doltCredsJwk: z.string().optional(),
        doltUserName: z.string().optional(),
        doltUserEmail: z.string().email().optional(),
        isUpstreamAdmin: z.boolean().optional(),
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
      const credential = await stub.storeCredential({
        userId: ctx.userId,
        encryptedToken,
        dolthubOrg: input.dolthubOrg,
        rigHandle: input.rigHandle,
        isUpstreamAdmin: input.isUpstreamAdmin,
      });

      // Inject token and config into the container env vars (persisted
      // for next boot) and tell the running container to init immediately.
      const config = await stub.getConfig();
      if (config && config.owner_user_id === ctx.userId) {
        const container = getWastelandContainerStub(ctx.env, input.wastelandId);
        await container.setEnvVar('DOLTHUB_TOKEN', input.dolthubToken);
        await container.setEnvVar('DOLTHUB_ORG', input.dolthubOrg);
        if (input.doltCredsJwk) {
          await container.setEnvVar('DOLT_CREDS_JWK', input.doltCredsJwk);
        }
        if (input.doltUserName) {
          await container.setEnvVar('DOLT_USER_NAME', input.doltUserName);
        }
        if (input.doltUserEmail) {
          await container.setEnvVar('DOLT_USER_EMAIL', input.doltUserEmail);
        }
        if (config.dolthub_upstream) {
          await container.setEnvVar('WL_UPSTREAM', config.dolthub_upstream);

          // Tell the (possibly already running) container to init now.
          // Surface failures so the user knows init didn't work.
          const initRes = await container.fetch(
            new Request('http://container/wl/init', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                upstream: config.dolthub_upstream,
                token: input.dolthubToken,
                dolthubOrg: input.dolthubOrg,
              }),
            })
          );
          if (!initRes.ok) {
            const body = await initRes.text().catch(() => '');
            console.warn(`[storeCredential] container init returned ${initRes.status}: ${body}`);
          }
        }
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
        is_upstream_admin: credential.is_upstream_admin,
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
        is_upstream_admin: credential.is_upstream_admin,
        connected_at: credential.connected_at,
      };
    }),

  // ── Credential: Set upstream-admin flag ─────────────────────────────
  // Lets a user flip the "I own this upstream" checkbox after connect.

  setUpstreamAdmin: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        isUpstreamAdmin: z.boolean(),
      })
    )
    .output(RpcWastelandCredentialStatusOutput.nullable())
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      const credential = await stub.setIsUpstreamAdmin(ctx.userId, input.isUpstreamAdmin);
      if (!credential) return null;
      return {
        user_id: credential.user_id,
        dolthub_org: credential.dolthub_org,
        rig_handle: credential.rig_handle,
        is_upstream_admin: credential.is_upstream_admin,
        connected_at: credential.connected_at,
      };
    }),

  // ── Credential: Delete ─────────────────────────────────────────────

  deleteCredential: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      // Verify the caller is a member/owner of this wasteland before
      // allowing credential deletion. The userId itself comes from the
      // JWT (so users can only delete their own credential), but without
      // this check any authenticated user could target arbitrary DOs.
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);

      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      await stub.deleteCredential(ctx.userId);

      meterEvent(ctx.env, {
        event: 'billing.credential_deleted',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
      });

      return { success: true };
    }),

  // ── Container Status ────────────────────────────────────────────────

  containerStatus: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(
      z.object({
        joined: z.boolean(),
        upstream: z.string().nullable(),
        dolthubOrg: z.string().nullable(),
        hasToken: z.boolean(),
        hasJwk: z.boolean(),
        doltCredPubKey: z.string().nullable(),
        wlVersion: z.string(),
        uptime: z.number(),
        lastOperation: z.string().nullable(),
      })
    )
    .query(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);

      const container = getWastelandContainerStub(ctx.env, input.wastelandId);
      const res = await container.fetch(
        new Request('http://container/wl/config', { method: 'GET' })
      );

      if (!res.ok) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Container status check failed: ${res.statusText}`,
        });
      }

      const data: unknown = await res.json();
      return z
        .object({
          joined: z.boolean(),
          upstream: z.string().nullable(),
          dolthubOrg: z.string().nullable(),
          hasToken: z.boolean(),
          hasJwk: z.boolean(),
          doltCredPubKey: z.string().nullable(),
          wlVersion: z.string(),
          uptime: z.number(),
          lastOperation: z.string().nullable(),
        })
        .parse(data);
    }),

  containerJoin: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);

      const doStub = getWastelandDOStub(ctx.env, input.wastelandId);
      const config = await doStub.getConfig();
      if (!config?.dolthub_upstream) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'No DoltHub upstream configured',
        });
      }

      const credential = await doStub.getCredential(ctx.userId);
      if (!credential) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'No DoltHub credential stored',
        });
      }

      const rawKey = await resolveSecret(ctx.env.WASTELAND_ENCRYPTION_KEY);
      if (!rawKey) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Encryption key unavailable',
        });
      }
      const cryptoKey = await deriveEncryptionKey(rawKey);
      const token = await decryptToken(credential.encrypted_token, cryptoKey);

      const container = getWastelandContainerStub(ctx.env, input.wastelandId);
      const res = await container.fetch(
        new Request('http://container/wl/init', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            upstream: config.dolthub_upstream,
            token,
            dolthubOrg: credential.dolthub_org,
          }),
        })
      );

      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Container join failed: ${body || res.statusText}`,
        });
      }

      return { success: true };
    }),

  // ── Connected Towns ────────────────────────────────────────────────

  connectKiloTown: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        townId: z.string().uuid(),
      })
    )
    .output(RpcConnectedTownOutput)
    .mutation(async ({ ctx, input }) => {
      // Verify user has access to this wasteland (owner, org member, or admin)
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);

      // TODO: Add server-side town ownership validation once a Gastown service
      // binding is available. Currently, the Wasteland worker has no binding to
      // Gastown (see wrangler.jsonc), so we cannot verify that `townId` belongs
      // to the caller. The risk is limited — connecting an unowned town here
      // does not grant the caller access to it — but a malicious user could
      // associate someone else's town with this wasteland. The `connected_by`
      // field records who made the connection for auditing.

      const stub = getWastelandDOStub(ctx.env, input.wastelandId);

      // Auto-register the user as a member if not already one
      const existingMember = await stub.getMember(ctx.userId);
      if (!existingMember) {
        await stub.addMember(ctx.userId, 'contributor', 1);
      }

      // Store the town-wasteland association
      const connection = await stub.connectTown(input.townId, ctx.userId);

      meterEvent(ctx.env, {
        event: 'billing.api_operation',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
        label: 'connect_town',
      });

      return connection;
    }),

  disconnectKiloTown: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        townId: z.string().uuid(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      // Only owners/admins can disconnect towns
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);

      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      await stub.disconnectTown(input.townId);

      meterEvent(ctx.env, {
        event: 'billing.api_operation',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
        label: 'disconnect_town',
      });

      return { success: true };
    }),

  listConnectedTowns: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(z.array(RpcConnectedTownOutput))
    .query(async ({ ctx, input }) => {
      // Any member or owner can list connected towns
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      return stub.listConnectedTowns();
    }),

  // ── Wanted Board ──────────────────────────────────────────────────

  browseWantedBoard: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(z.array(RpcWantedBoardRowOutput))
    .query(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await wantedBoard.browseWantedBoard(ctx.env, input.wastelandId, ctx.userId);
      } catch (err) {
        // Browse degrades to empty list if not yet configured
        if (err instanceof WantedBoardOpError && err.code === 'PRECONDITION_FAILED') {
          return [];
        }
        return wantedBoardErrorToTRPC(err);
      }
    }),

  // ── Wanted Board Mutations ────────────────────────────────────────

  claimWantedItem: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        itemId: z.string().min(1),
        direct: z.boolean().optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await wantedBoard.claimWantedItem(
          ctx.env,
          input.wastelandId,
          ctx.userId,
          input.itemId,
          { direct: input.direct }
        );
      } catch (err) {
        return wantedBoardErrorToTRPC(err);
      }
    }),

  unclaimWantedItem: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        itemId: z.string().min(1),
        direct: z.boolean().optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await wantedBoard.unclaimWantedItem(
          ctx.env,
          input.wastelandId,
          ctx.userId,
          input.itemId,
          { direct: input.direct }
        );
      } catch (err) {
        return wantedBoardErrorToTRPC(err);
      }
    }),

  postWantedItem: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        title: z.string().min(1).max(256),
        description: z.string().min(1).max(4096),
        priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        type: z.enum(['feature', 'bug', 'docs', 'other']).optional(),
        direct: z.boolean().optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await wantedBoard.postWantedItem(ctx.env, input.wastelandId, ctx.userId, {
          title: input.title,
          description: input.description,
          priority: input.priority,
          type: input.type,
          direct: input.direct,
        });
      } catch (err) {
        return wantedBoardErrorToTRPC(err);
      }
    }),

  markWantedItemDone: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        itemId: z.string().min(1),
        evidence: z.string().url().min(1),
        direct: z.boolean().optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await wantedBoard.markWantedItemDone(ctx.env, input.wastelandId, ctx.userId, {
          itemId: input.itemId,
          evidence: input.evidence,
          direct: input.direct,
        });
      } catch (err) {
        return wantedBoardErrorToTRPC(err);
      }
    }),

  acceptWantedItem: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        itemId: z.string().min(1),
        quality: z.enum(['excellent', 'good', 'fair', 'poor']),
        comment: z.string().optional(),
        direct: z.boolean().optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await wantedBoard.acceptWantedItem(ctx.env, input.wastelandId, ctx.userId, {
          itemId: input.itemId,
          quality: input.quality,
          comment: input.comment,
          direct: input.direct,
        });
      } catch (err) {
        return wantedBoardErrorToTRPC(err);
      }
    }),

  rejectWantedItem: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        itemId: z.string().min(1),
        comment: z.string().min(1),
        direct: z.boolean().optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await wantedBoard.rejectWantedItem(ctx.env, input.wastelandId, ctx.userId, {
          itemId: input.itemId,
          comment: input.comment,
          direct: input.direct,
        });
      } catch (err) {
        return wantedBoardErrorToTRPC(err);
      }
    }),

  closeWantedItem: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        itemId: z.string().min(1),
        direct: z.boolean().optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await wantedBoard.closeWantedItem(
          ctx.env,
          input.wastelandId,
          ctx.userId,
          input.itemId,
          { direct: input.direct }
        );
      } catch (err) {
        return wantedBoardErrorToTRPC(err);
      }
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
