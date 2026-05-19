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
import { resolveWasteland } from './resolve-wasteland';
import { getWastelandDOStub, type WastelandMemberResult } from '../dos/Wasteland.do';
import { getWastelandRegistryStub } from '../dos/WastelandRegistry.do';
import { createUpstream as bootstrapCreateUpstream } from '../upstream-bootstrap/create-upstream';
import { deriveEncryptionKey, encryptToken, decryptToken } from '../util/crypto.util';
import { resolveSecret } from '../util/secret.util';
import { meterEvent } from '../util/billing.util';
import { fetchFreshDoltHubToken } from '../util/dolthub-token.util';
import * as wantedBoard from '../wanted-board/wanted-board-ops-sdk';
import { WantedBoardOpError } from '../wanted-board/errors';
import * as branchOps from '../branch-ops/branch-ops';
import * as lifecycleOps from '../lifecycle-ops/lifecycle-ops';
import * as doltApi from '../util/dolthub-api.util';
import * as inbox from '../inbox/inbox-classifier';
import {
  RpcWastelandOutput,
  RpcWastelandMemberOutput,
  RpcWastelandConfigOutput,
  RpcWastelandCredentialStatusOutput,
  RpcConnectedTownOutput,
  RpcWantedBoardRowOutput,
  RpcInboxItemOutput,
  RpcUpstreamAdminVerifyOutput,
  RpcMergePullOutput,
  RpcPendingClaimOutput,
  RpcUpstreamRigOutput,
  RpcRigDetailOutput,
  RpcRigActivityOutput,
  RpcForkBranchOutput,
  RpcMyPullOutput,
  RpcPublishBranchOutput,
  WantedBoardRowOutput,
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
 * Parse raw DoltHub rows as WantedBoardRowOutput. Used by listRigActivity
 * to validate per-row shape without throwing when an optional column is
 * null (Zod defaults cover that).
 */
function parseWantedBoardRows(rows: unknown[]) {
  const parsed = z.array(WantedBoardRowOutput).safeParse(rows);
  return parsed.success ? parsed.data : [];
}

/**
 * Parse a `stamps` JOIN result from DoltHub into the shape StampOutput
 * expects. Shared by `listRigActivity`'s authored + received queries.
 */
function parseStampRows(rows: unknown[]) {
  const parsed = z
    .array(
      z.object({
        stamp_id: z.string(),
        author: z.string(),
        subject: z.string(),
        valence: z.string().nullable().default(null),
        confidence: z.union([z.string(), z.number()]).nullable().default(null),
        severity: z.string().nullable().default(null),
        skill_tags: z.string().nullable().default(null),
        message: z.string().nullable().default(null),
        context_id: z.string().nullable().default(null),
        context_type: z.string().nullable().default(null),
        wanted_id: z.string().nullable().default(null),
        wanted_title: z.string().nullable().default(null),
      })
    )
    .safeParse(rows);
  return parsed.success ? parsed.data : [];
}

/** Translate a WantedBoardOpError into the matching TRPCError. */
function wantedBoardErrorToTRPC(err: unknown): never {
  if (err instanceof WantedBoardOpError) {
    console.warn('[wasteland-trpc] wanted board operation failed', {
      code: err.code,
      message: err.message,
      cause:
        err.cause instanceof Error
          ? { name: err.cause.name, message: err.cause.message }
          : err.cause === undefined
            ? undefined
            : JSON.stringify(err.cause),
    });
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
 * Load a decrypted DoltHub token + upstream for the caller's credential.
 * Shared between admin procedures (mergeUpstreamPR, verifyUpstreamAdmin)
 * and any non-admin procedure that needs a DoltHub REST API call on the
 * caller's behalf (listMyPendingClaims). Admin-only procedures enforce
 * `isUpstreamAdmin` themselves — the name is historical.
 *
 * Token resolution order mirrors `wanted-board-ops.loadContext`:
 *
 * 1. **Fresh OAuth token from the web app** via the internal token
 *    endpoint, which transparently refreshes via OAuth refresh_token.
 * 2. **Locally encrypted credential** as a fallback for users who
 *    connected via the manual API token path (production), and for
 *    transient failures of the fresh-token path.
 *
 * The local credential row is also the source of `is_upstream_admin`
 * and `rig_handle`, which are not exposed by the fresh-token endpoint.
 */
async function loadAdminContext(
  env: Env,
  wastelandId: string,
  userId: string
): Promise<{
  token: string;
  upstream: string;
  isUpstreamAdmin: boolean;
  rigHandle: string;
  /** DoltHub username/org — needed for the rig row's `dolthub_org` column. */
  dolthubOrg: string | null;
}> {
  const doStub = getWastelandDOStub(env, wastelandId);
  const config = await doStub.getConfig();
  if (!config?.dolthub_upstream) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'Wasteland has no DoltHub upstream configured',
    });
  }

  const fresh = await fetchFreshDoltHubToken(env, { userId });
  const credential = await doStub.getCredential(userId);

  // Resolve the rig handle. Falls back to the DoltHub username (from
  // either source) so OAuth-only users still get a non-UUID handle.
  const dolthubOrg =
    (fresh.status === 'ok' ? fresh.data.dolthubUsername : null) ?? credential?.dolthub_org ?? null;
  const rigHandle = credential?.rig_handle ?? dolthubOrg ?? userId;
  const isUpstreamAdmin = credential?.is_upstream_admin ?? false;

  if (fresh.status === 'ok') {
    return {
      token: fresh.data.token,
      upstream: config.dolthub_upstream,
      isUpstreamAdmin,
      rigHandle,
      dolthubOrg,
    };
  }

  if (fresh.status === 'unavailable') {
    console.warn('[loadAdminContext] fresh DoltHub token unavailable, falling back', {
      wastelandId,
      userId,
      reason: fresh.reason,
    });
  }

  if (!credential) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'No DoltHub credential stored — connect DoltHub first',
    });
  }
  const rawKey = await resolveSecret(env.WASTELAND_ENCRYPTION_KEY);
  if (!rawKey) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Encryption key unavailable',
    });
  }
  const cryptoKey = await deriveEncryptionKey(rawKey);
  const token = await decryptToken(credential.encrypted_token, cryptoKey);
  return {
    token,
    upstream: config.dolthub_upstream,
    isUpstreamAdmin: credential.is_upstream_admin,
    rigHandle,
    dolthubOrg,
  };
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
        visibility: z.enum(['public', 'private']).optional(),
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
        visibility: 'public',
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
        dolthub_upstream: input.dolthubUpstream ?? null,
      });

      meterEvent(ctx.env, {
        event: 'billing.wasteland_created',
        userId: ctx.userId,
        wastelandId,
      });

      return config;
    }),

  // ── Create Upstream (worker-side bootstrap of a new commons) ────────
  // Bootstraps a brand-new DoltHub commons repo: creates the database
  // via DoltHub's REST API, applies the wasteland commons schema, and
  // registers the caller as the first rig with `trust_level=1`.
  // Requires the caller's credential to already be stored AND marked
  // as upstream-admin. Should only be called as part of the "create
  // your own wasteland" flow after storeCredential has run.
  //
  // Implementation lives in `upstream-bootstrap/`.
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
    .output(z.object({ success: z.boolean(), databaseCreated: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);

      // Resolve credentials inline rather than via loadAdminContext —
      // the latter requires `config.dolthub_upstream` to already be
      // set, but createUpstream is the call that *establishes* it.
      // The upstream-bootstrap path always uses the explicit input
      // upstream regardless of what's on the config.
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

      // Token resolution: prefer fresh OAuth, fall back to the locally
      // encrypted credential. Same shape as `loadAdminContext` but
      // without the upstream-on-config precondition.
      const fresh = await fetchFreshDoltHubToken(ctx.env, { userId: ctx.userId });
      const dolthubOrg =
        (fresh.status === 'ok' ? fresh.data.dolthubUsername : null) ?? credential.dolthub_org;
      if (!dolthubOrg) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message:
            'DoltHub username unknown — reconnect DoltHub in settings to refresh your credential',
        });
      }
      let token: string;
      if (fresh.status === 'ok') {
        token = fresh.data.token;
      } else {
        if (fresh.status === 'unavailable') {
          console.warn('[createUpstream] fresh DoltHub token unavailable, falling back', {
            wastelandId: input.wastelandId,
            userId: ctx.userId,
            reason: fresh.reason,
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
        token = await decryptToken(credential.encrypted_token, cryptoKey);
      }

      const config = await doStub.getConfig();
      const handle = input.rigHandle ?? credential.rig_handle ?? dolthubOrg;
      const displayName = input.rigDisplayName ?? config?.name ?? handle;
      const ownerEmail = input.rigEmail ?? `${handle}@kilo.local`;

      let result: Awaited<ReturnType<typeof bootstrapCreateUpstream>>;
      try {
        result = await bootstrapCreateUpstream({
          upstream: input.upstream,
          token,
          rigHandle: handle,
          rigDisplayName: displayName,
          ownerEmail,
          dolthubOrg,
          wastelandName: config?.name,
          visibility: 'public',
        });
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `wl create failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Persist the upstream on the wasteland config now that the repo exists.
      await doStub.updateConfig({ dolthub_upstream: input.upstream });

      // Sync the new upstream onto the central registry so the
      // `<owner>/<repo>` lookup contract returns this wasteland.
      const registryStub = getWastelandRegistryStub(ctx.env);
      await registryStub.setDolthubUpstream(input.wastelandId, input.upstream);

      meterEvent(ctx.env, {
        event: 'billing.api_operation',
        userId: ctx.userId,
        wastelandId: input.wastelandId,
        label: 'create_upstream',
      });

      return { success: true, databaseCreated: result.databaseCreated };
    }),

  // ── Join Wasteland (M2.7 explicit fork+register ceremony) ───────────
  // Runs `WlClient.join()` on behalf of the caller: forks the upstream
  // to the user's DoltHub account, writes the rig registration row to
  // `wl/register/<handle>`, and opens the registration PR. After the
  // ceremony succeeds we persist the verified rig handle onto the
  // wasteland's stored credential so subsequent ops resolve the same
  // handle the join PR was opened under.
  //
  // Idempotent: re-running with the same handle returns the existing
  // PR (the SDK handles fork-already-exists, registration write uses
  // ON DUPLICATE KEY UPDATE, and an open PR matching the title is
  // returned rather than re-opened).

  joinWasteland: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        rigHandle: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_-]+$/, 'rigHandle must be lowercase letters/digits/_-'),
        rigDisplayName: z.string().min(1).max(128).optional(),
        rigEmail: z.string().email().optional(),
      })
    )
    .output(
      z.object({
        forkOwner: z.string(),
        forkRepo: z.string(),
        forkUrl: z.string(),
        rigHandle: z.string(),
        registrationBranch: z.string(),
        registrationPullId: z.string().nullable(),
        registrationPullUrl: z.string().nullable(),
        alreadyJoined: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await lifecycleOps.joinWasteland(ctx.env, input.wastelandId, ctx.userId, {
          rigHandle: input.rigHandle,
          rigDisplayName: input.rigDisplayName,
          rigEmail: input.rigEmail,
        });
      } catch (err) {
        return wantedBoardErrorToTRPC(err);
      }
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

  // ── Resolve <owner>/<repo> → wastelandId ───────────────────────────
  // Powers the `/wasteland/:owner/:repo` route family in apps/web.
  // Tells you what wasteland (if any) is registered under that
  // upstream slug. Auth is intentionally NOT enforced here — the caller
  // either 404s on null or layers ownership checks when it forwards
  // the resolved `wastelandId` to a UUID-keyed procedure.
  //
  // Slug comparison is case-insensitive (DoltHub slug convention).

  resolveOwnerRepo: procedure
    .input(
      z.object({
        owner: z.string().min(1).max(64),
        repo: z.string().min(1).max(64),
      })
    )
    .output(
      z
        .object({
          wastelandId: z.string(),
          ownerType: z.enum(['user', 'org']),
          ownerUserId: z.string().nullable(),
          organizationId: z.string().nullable(),
          name: z.string(),
        })
        .nullable()
    )
    .query(async ({ ctx, input }) => {
      const resolved = await resolveWasteland(ctx.env, input);
      if (!resolved) return null;
      return {
        wastelandId: resolved.wastelandId,
        ownerType: resolved.ownerType,
        ownerUserId: resolved.ownerUserId,
        organizationId: resolved.organizationId,
        name: resolved.name,
      };
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
        ...(input.dolthubUpstream !== undefined ? { dolthub_upstream: input.dolthubUpstream } : {}),
      });

      // Mirror dolthub_upstream onto the central registry so the
      // `<owner>/<repo>` lookup stays in sync. Treat empty string as
      // "clear" so the registry can fall back to a null sentinel.
      if (input.dolthubUpstream !== undefined) {
        const registryStub = getWastelandRegistryStub(ctx.env);
        const next = input.dolthubUpstream.length > 0 ? input.dolthubUpstream : null;
        await registryStub.setDolthubUpstream(input.wastelandId, next);
      }

      // No env-var sync needed: the SDK reads the upstream off the DO
      // config on every op.

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

      // No env-var sync needed: the SDK adapter resolves credentials
      // from `loadContext` directly on every op.

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
      // Privacy boundary: connected towns are user-owned Gastown metadata.
      // Upstream owners/admins can inspect public rig rows, but should not
      // see other users' town IDs or connection records here.
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      const stub = getWastelandDOStub(ctx.env, input.wastelandId);
      return stub.listConnectedTownsForUser(ctx.userId);
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

  // List open pull requests on the upstream that this user opened from
  // `wl/<rigHandle>/<itemId>` branches. Powers the "Pending review" badge
  // on the wanted board — while a claim/done/unclaim/edit PR is open but
  // not yet merged, upstream `main` still shows the prior state, so the
  // board alone can't show the user's in-flight work.
  //
  // Returns an empty list (never throws) when DoltHub is unreachable or
  // the caller has no credential yet — the badge is informational and
  // shouldn't break the board when upstream is degraded.
  listMyPendingClaims: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(z.object({ items: z.array(RpcPendingClaimOutput) }))
    .query(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      let loaded: Awaited<ReturnType<typeof loadAdminContext>>;
      try {
        loaded = await loadAdminContext(ctx.env, input.wastelandId, ctx.userId);
      } catch {
        // No credential / no upstream configured → no pending claims.
        return { items: [] };
      }
      const { token, upstream, rigHandle } = loaded;
      try {
        const openPulls = await doltApi.listPulls(upstream, token, { state: 'Open' });
        // Fast filter: DoltHub's list endpoint returns `creator_name` but
        // not the from-branch. The PR creator is the fork owner, which in
        // hosted mode is the rig handle. Drop anything created by someone
        // else before spending detail requests.
        const candidates = openPulls.filter(p => !p.creator_name || p.creator_name === rigHandle);
        const details = await doltApi.mapWithLimit(candidates, 6, p =>
          doltApi.getPull(upstream, token, p.pull_id).catch(() => null)
        );
        const items = details.flatMap(detail => {
          if (!detail) return [];
          const parsed = doltApi.parseWlBranch(detail.from_branch_name);
          if (!parsed || parsed.rigHandle !== rigHandle) return [];
          return [
            {
              item_id: parsed.itemId,
              pull_id: detail.pull_id,
              pr_url: doltApi.buildPullWebUrl(upstream, detail.pull_id),
              from_branch: detail.from_branch_name ?? '',
              state: 'Open' as const,
              created_at: detail.created_at,
              updated_at: detail.updated_at,
            },
          ];
        });
        return { items };
      } catch {
        return { items: [] };
      }
    }),

  // ── Workshop: list the user's fork branches ────────────────────────
  // Powers the fork (workshop) view. Returns one row per
  // `wl/<rigHandle>/*` branch on the caller's fork, cross-referenced
  // with upstream `main` and the branch tip so the UI can render
  // status pairs and divergence chips.
  listMyForkBranches: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(z.array(RpcForkBranchOutput))
    .query(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await branchOps.listMyForkBranches(ctx.env, input.wastelandId, ctx.userId);
      } catch (err) {
        if (err instanceof WantedBoardOpError) {
          // No upstream / no credential → empty workshop, not an error.
          if (err.code === 'PRECONDITION_FAILED') return [];
        }
        return wantedBoardErrorToTRPC(err);
      }
    }),

  // ── Workshop: discard a branch ──────────────────────────────────────
  // Deletes the user's `wl/<rigHandle>/<wantedId>` branch on the fork.
  // Idempotent: a missing branch resolves successfully.
  discardBranch: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        wantedId: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9_.:-]+$/, 'wantedId must be 1-64 chars, letters/digits/_-.:'),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await branchOps.discardBranch(
          ctx.env,
          input.wastelandId,
          ctx.userId,
          input.wantedId
        );
      } catch (err) {
        return wantedBoardErrorToTRPC(err);
      }
    }),

  // ── Workshop: publish a branch ──────────────────────────────────────
  // Opens or updates a PR for the user's `wl/<rigHandle>/<wantedId>`
  // branch. Idempotent: returns the existing PR's URL when one is
  // already open against the upstream.
  publishBranch: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        wantedId: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9_.:-]+$/, 'wantedId must be 1-64 chars, letters/digits/_-.:'),
      })
    )
    .output(RpcPublishBranchOutput)
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await branchOps.publishBranch(
          ctx.env,
          input.wastelandId,
          ctx.userId,
          input.wantedId
        );
      } catch (err) {
        return wantedBoardErrorToTRPC(err);
      }
    }),

  // ── Pulls: list the user's PRs against upstream ────────────────────
  // Powers the Mine tab on the pulls page. Filters all upstream pulls
  // down to those whose source branch is owned by the caller's fork.
  listMyPulls: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(z.array(RpcMyPullOutput))
    .query(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await branchOps.listMyPulls(ctx.env, input.wastelandId, ctx.userId);
      } catch (err) {
        if (err instanceof WantedBoardOpError) {
          // No upstream / no credential → empty list, not an error.
          if (err.code === 'PRECONDITION_FAILED') return [];
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
    .output(z.object({ success: z.boolean(), pr_url: z.string().nullable() }))
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

  editWantedItem: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        itemId: z.string().min(1),
        title: z.string().min(1).max(256).optional(),
        description: z.string().min(1).max(4096).optional(),
        priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
        type: z.enum(['feature', 'bug', 'docs', 'other']).optional(),
      })
    )
    .output(z.object({ success: z.boolean(), pr_url: z.string().nullable() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await wantedBoard.editWantedItem(ctx.env, input.wastelandId, ctx.userId, {
          itemId: input.itemId,
          title: input.title,
          description: input.description,
          priority: input.priority,
          type: input.type,
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
    .output(z.object({ success: z.boolean(), pr_url: z.string().nullable() }))
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

  /**
   * Fork-currency probe: compares the user's fork main HEAD to upstream
   * main HEAD without writing. UI uses this to drive the persistent
   * "Sync fork" button — green/disabled when current, prominent when
   * stale — and to read the `syncUrl` deep-link the button opens on
   * click.
   *
   * DoltHub's API does not expose a programmatic fork-sync. Cross-repo
   * `CALL DOLT_FETCH/MERGE` is blocked, and a fork owner lacks write on
   * the parent repo, so `POST /{forkOwner}/{forkDb}/pulls` with
   * `from=upstream:main` returns "must have write permissions on from
   * repository". The supported path is DoltHub's web UI "Sync from
   * upstream" button on `<fork>/pulls/new`.
   *
   * Best-effort — a null read on either side is treated as
   * "unknown, do not block."
   */
  getForkCurrency: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(
      z.object({
        upstream: z.string(),
        fork: z.string(),
        upstreamHead: z.string().nullable(),
        forkHead: z.string().nullable(),
        isCurrent: z.boolean(),
        syncUrl: z.string().url(),
      })
    )
    .query(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await wantedBoard.getForkCurrency(ctx.env, input.wastelandId, ctx.userId);
      } catch (err) {
        return wantedBoardErrorToTRPC(err);
      }
    }),

  acceptWantedItem: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        itemId: z.string().min(1),
        /**
         * Pull id of the worker's original `wl done` PR. Threaded
         * through from the inbox card so the server can close the
         * stale PR after merging the admin's adoption.
         */
        submitterPullId: z.string().min(1).optional(),
        /**
         * Worker's rig handle (the `<rig>` in `wl/<rig>/<id>`).
         * Inbox classifier already exposes this as
         * `work-submission.submitter`.
         */
        submitterRigHandle: z.string().min(1).optional(),
        /**
         * DoltHub owner of the worker's fork. Required for cross-fork
         * accept reads; inbox classifier exposes this as
         * `work-submission.fork_owner`.
         */
        submitterForkOwner: z.string().min(1).optional(),
        /** Completion id from the worker's branch (inbox `completion_id`). */
        completionId: z.string().min(1).optional(),
        /** Evidence URL from the worker's submission (inbox `evidence_url`). */
        evidence: z.string().optional(),
        quality: z.enum(['excellent', 'good', 'fair', 'poor']),
        reliability: z.enum(['excellent', 'good', 'fair', 'poor']).optional(),
        severity: z.enum(['leaf', 'branch', 'root']).optional(),
        skillTags: z.array(z.string().min(1).max(64)).max(16).optional(),
        /**
         * Free-form message attached to the reputation stamp
         * (`stamps.message`). Maps to `wl accept --message`.
         */
        message: z.string().optional(),
        direct: z.boolean().optional(),
      })
    )
    .output(
      z.object({
        success: z.boolean(),
        pr_url: z.string().nullable(),
        pr_id: z.string().nullable(),
        merged: z.boolean(),
        closed_submitter_pr: z.boolean(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await wantedBoard.acceptWantedItem(ctx.env, input.wastelandId, ctx.userId, {
          itemId: input.itemId,
          submitterPullId: input.submitterPullId,
          submitterRigHandle: input.submitterRigHandle,
          submitterForkOwner: input.submitterForkOwner,
          completionId: input.completionId,
          evidence: input.evidence,
          quality: input.quality,
          reliability: input.reliability,
          severity: input.severity,
          skillTags: input.skillTags,
          message: input.message,
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
        /**
         * Rejection reason — becomes part of the `wl reject` commit
         * message. Maps to `--reason` on the wl CLI.
         */
        reason: z.string().min(1),
        direct: z.boolean().optional(),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await resolveWastelandOwnership(ctx.env, ctx, input.wastelandId);
      try {
        return await wantedBoard.rejectWantedItem(ctx.env, input.wastelandId, ctx.userId, {
          itemId: input.itemId,
          reason: input.reason,
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

  // ── Admin: Upstream PR management ──────────────────────────────────
  // Admins with `is_upstream_admin=true` can list/merge/close upstream PRs
  // using the stored DoltHub credential. Non-admins get FORBIDDEN since
  // the underlying DoltHub API would reject the write anyway.

  mergeUpstreamPR: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        pullId: z.string().min(1),
      })
    )
    .output(RpcMergePullOutput)
    .mutation(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);
      const { token, upstream, isUpstreamAdmin } = await loadAdminContext(
        ctx.env,
        input.wastelandId,
        ctx.userId
      );
      if (!isUpstreamAdmin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admin mode required to merge upstream PRs',
        });
      }
      try {
        const result = await doltApi.mergePull(upstream, token, input.pullId);
        meterEvent(ctx.env, {
          event: 'billing.api_operation',
          userId: ctx.userId,
          wastelandId: input.wastelandId,
          label: 'merge_pr',
        });
        return { pull_id: input.pullId, state: result.state };
      } catch (err) {
        if (err instanceof doltApi.DoltHubApiError) {
          throw new TRPCError({
            code: err.status === 401 || err.status === 403 ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR',
            message: err.message,
          });
        }
        throw err;
      }
    }),

  closeUpstreamPR: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        pullId: z.string().min(1),
      })
    )
    .output(RpcMergePullOutput)
    .mutation(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);
      const { token, upstream, isUpstreamAdmin } = await loadAdminContext(
        ctx.env,
        input.wastelandId,
        ctx.userId
      );
      if (!isUpstreamAdmin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admin mode required to close upstream PRs',
        });
      }
      try {
        const result = await doltApi.closePull(upstream, token, input.pullId);
        meterEvent(ctx.env, {
          event: 'billing.api_operation',
          userId: ctx.userId,
          wastelandId: input.wastelandId,
          label: 'close_pr',
        });
        return { pull_id: input.pullId, state: result.state };
      } catch (err) {
        if (err instanceof doltApi.DoltHubApiError) {
          throw new TRPCError({
            code: err.status === 401 || err.status === 403 ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR',
            message: err.message,
          });
        }
        throw err;
      }
    }),

  // ── Admin: Verify upstream write access ─────────────────────────────
  // Probes DoltHub by attempting a no-op write against a scratch branch.
  // Returns hasWriteAccess=true only when the write API reports success
  // (a DoltHub token without push rights returns 403 here).

  verifyUpstreamAdmin: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(RpcUpstreamAdminVerifyOutput)
    .mutation(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);
      const { token, upstream, isUpstreamAdmin } = await loadAdminContext(
        ctx.env,
        input.wastelandId,
        ctx.userId
      );
      if (!isUpstreamAdmin) {
        return {
          hasWriteAccess: false,
          error: 'Credential is not marked as admin. Toggle "I own this upstream" first.',
        };
      }
      // Use a unique scratch branch so concurrent verifications don't collide.
      // DoltHub write API forks the target branch; a no-op DML (SELECT 1)
      // is enough to probe auth without mutating data. Cleanup runs in
      // `finally` so the branch is always deleted exactly once regardless
      // of whether the probe succeeded or failed.
      const scratchBranch = `admin-verify-${crypto.randomUUID().slice(0, 8)}`;
      try {
        await doltApi.runWrite(upstream, token, 'main', scratchBranch, 'SELECT 1');
        return { hasWriteAccess: true, error: null };
      } catch (err) {
        if (err instanceof doltApi.DoltHubApiError) {
          return {
            hasWriteAccess: false,
            error: err.message,
          };
        }
        return {
          hasWriteAccess: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        };
      } finally {
        await doltApi.deleteBranch(upstream, token, scratchBranch);
      }
    }),

  // ── Admin: Review inbox (typed view of open upstream PRs) ──────────
  // Replaces the raw `listPendingPRs` surface for UI clients. Classifies
  // each PR into a typed card kind by parsing commit subjects and
  // querying the branch tip for row-level context (item title, evidence,
  // stamp, rig details).

  listInboxItems: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(z.object({ items: z.array(RpcInboxItemOutput) }))
    .query(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);
      const { token, upstream, isUpstreamAdmin } = await loadAdminContext(
        ctx.env,
        input.wastelandId,
        ctx.userId
      );
      if (!isUpstreamAdmin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admin mode required to view the review inbox',
        });
      }
      try {
        const items = await inbox.listInboxItems(upstream, token);
        return { items };
      } catch (err) {
        if (err instanceof doltApi.DoltHubApiError) {
          throw new TRPCError({
            code: err.status === 401 || err.status === 403 ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR',
            message: err.message,
          });
        }
        throw err;
      }
    }),

  // ── Admin: Post a comment on an upstream PR ────────────────────────

  commentOnUpstreamPR: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        pullId: z.string().min(1),
        comment: z.string().min(1).max(10_000),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);
      const { token, upstream, isUpstreamAdmin } = await loadAdminContext(
        ctx.env,
        input.wastelandId,
        ctx.userId
      );
      if (!isUpstreamAdmin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admin mode required to comment on upstream PRs',
        });
      }
      try {
        await doltApi.commentOnPull(upstream, token, input.pullId, input.comment);
        meterEvent(ctx.env, {
          event: 'billing.api_operation',
          userId: ctx.userId,
          wastelandId: input.wastelandId,
          label: 'pr_comment',
        });
        return { success: true };
      } catch (err) {
        if (err instanceof doltApi.DoltHubApiError) {
          throw new TRPCError({
            code: err.status === 401 || err.status === 403 ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR',
            message: err.message,
          });
        }
        throw err;
      }
    }),

  // ── Admin: List rigs registered on upstream ─────────────────────────

  listUpstreamRigs: procedure
    .input(z.object({ wastelandId: z.string().uuid() }))
    .output(z.object({ rigs: z.array(RpcUpstreamRigOutput) }))
    .query(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);
      const { token, upstream } = await loadAdminContext(ctx.env, input.wastelandId, ctx.userId);
      try {
        const result = await doltApi.runUnsafeSql(
          upstream,
          token,
          'main',
          `SELECT handle, display_name, trust_level, registered_at, last_seen FROM rigs ORDER BY registered_at DESC`
        );
        const rigRow = z.object({
          handle: z.string(),
          display_name: z.string().nullable().default(null),
          trust_level: z.union([z.string(), z.number()]).transform(v => Number(v)),
          registered_at: z.string().nullable().default(null),
          last_seen: z.string().nullable().default(null),
        });
        const rows = z.array(rigRow).safeParse(result.rows ?? []);
        const rigs = (rows.success ? rows.data : []).map(r => ({
          rig_handle: r.handle,
          display_name: r.display_name,
          trust_level: r.trust_level,
          registered_at: r.registered_at,
          last_seen_at: r.last_seen,
        }));
        return { rigs };
      } catch (err) {
        if (err instanceof doltApi.DoltHubApiError) {
          throw new TRPCError({
            code: err.status === 401 || err.status === 403 ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR',
            message: err.message,
          });
        }
        throw err;
      }
    }),

  // ── Admin: Single-entity fetchers (for drawer graph navigation) ──────
  // These are deliberately small, targeted reads against upstream `main`.
  // Drawer panels use them when a user clicks a cross-reference (e.g. a
  // rig handle in a PR drawer → push rig drawer) and we don't already
  // have the full row loaded on the page.

  getRig: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        handle: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_-]+$/, 'handle must be alphanumeric with - or _ only'),
      })
    )
    .output(RpcRigDetailOutput.nullable())
    .query(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);
      const { token, upstream } = await loadAdminContext(ctx.env, input.wastelandId, ctx.userId);
      try {
        // `input.handle` is Zod-validated against /^[a-zA-Z0-9_-]+$/ and
        // bounded at 64 chars, so the string CANNOT carry quotes, spaces,
        // semicolons, comment markers, or any other injection vector.
        const result = await doltApi.runUnsafeSql(
          upstream,
          token,
          'main',
          `SELECT handle, display_name, trust_level, dolthub_org, owner_email, hop_uri, gt_version, registered_at, last_seen FROM rigs WHERE handle = '${input.handle}' LIMIT 1`
        );
        const rigRow = z.object({
          handle: z.string(),
          display_name: z.string().nullable().default(null),
          trust_level: z.union([z.string(), z.number()]).transform(v => Number(v)),
          dolthub_org: z.string().nullable().default(null),
          owner_email: z.string().nullable().default(null),
          hop_uri: z.string().nullable().default(null),
          gt_version: z.string().nullable().default(null),
          registered_at: z.string().nullable().default(null),
          last_seen: z.string().nullable().default(null),
        });
        const rows = z.array(rigRow).safeParse(result.rows ?? []);
        if (!rows.success || rows.data.length === 0) return null;
        const r = rows.data[0];
        return {
          rig_handle: r.handle,
          display_name: r.display_name,
          trust_level: r.trust_level,
          dolthub_org: r.dolthub_org,
          owner_email: r.owner_email,
          hop_uri: r.hop_uri,
          gt_version: r.gt_version,
          registered_at: r.registered_at,
          last_seen_at: r.last_seen,
        };
      } catch (err) {
        if (err instanceof doltApi.DoltHubApiError) {
          throw new TRPCError({
            code: err.status === 401 || err.status === 403 ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR',
            message: err.message,
          });
        }
        throw err;
      }
    }),

  getWantedItem: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        // The `wanted` table declares `id` as VARCHAR(64) with no structural
        // check — in practice ids range from the `wl` CLI's `w-<10 hex>`
        // convention to hand-rolled values. Enforce a permissive character
        // class that blocks SQL-injection metacharacters (quotes, backslash,
        // semicolons, whitespace, comment markers) while letting through
        // anything the column will actually hold.
        itemId: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9_.:-]+$/, 'itemId must be 1-64 chars, letters/digits/_-.:'),
      })
    )
    .output(RpcWantedBoardRowOutput.nullable())
    .query(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);
      const { token, upstream } = await loadAdminContext(ctx.env, input.wastelandId, ctx.userId);
      try {
        // `input.itemId` passed the regex above — safe to interpolate.
        const result = await doltApi.runUnsafeSql(
          upstream,
          token,
          'main',
          `SELECT id, title, description, project, type, priority, tags, posted_by, claimed_by, status, effort_level, evidence_url, sandbox_required, sandbox_scope, sandbox_min_tier, created_at, updated_at FROM wanted WHERE id = '${input.itemId}' LIMIT 1`
        );
        const rows = parseWantedBoardRows(result.rows ?? []);
        return rows[0] ?? null;
      } catch (err) {
        if (err instanceof doltApi.DoltHubApiError) {
          throw new TRPCError({
            code: err.status === 401 || err.status === 403 ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR',
            message: err.message,
          });
        }
        throw err;
      }
    }),

  listRigActivity: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        handle: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_-]+$/, 'handle must be alphanumeric with - or _ only'),
        limit: z.number().int().min(1).max(200).default(50),
      })
    )
    .output(RpcRigActivityOutput)
    .query(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);
      const { token, upstream } = await loadAdminContext(ctx.env, input.wastelandId, ctx.userId);
      const { handle, limit } = input;
      // `handle` is Zod-validated against /^[a-zA-Z0-9_-]+$/; safe to interpolate.
      // `limit` is a bounded integer; safe.
      const wantedCols =
        'id, title, description, project, type, priority, tags, posted_by, claimed_by, status, effort_level, evidence_url, sandbox_required, sandbox_scope, sandbox_min_tier, created_at, updated_at';
      const postedSql = `SELECT ${wantedCols} FROM wanted WHERE posted_by = '${handle}' ORDER BY created_at DESC LIMIT ${limit}`;
      const claimedSql = `SELECT ${wantedCols} FROM wanted WHERE claimed_by = '${handle}' ORDER BY updated_at DESC LIMIT ${limit}`;
      const completionsSql = `SELECT c.id AS completion_id, c.wanted_id, c.completed_by, c.evidence, c.hop_uri, c.validated_by, c.stamp_id, c.completed_at, w.title AS wanted_title FROM completions c LEFT JOIN wanted w ON w.id = c.wanted_id WHERE c.completed_by = '${handle}' ORDER BY c.completed_at DESC LIMIT ${limit}`;
      const stampsAuthoredSql = `SELECT s.id AS stamp_id, s.author, s.subject, s.valence, s.confidence, s.severity, s.skill_tags, s.message, s.context_id, s.context_type, c.wanted_id, w.title AS wanted_title FROM stamps s LEFT JOIN completions c ON c.id = s.context_id LEFT JOIN wanted w ON w.id = c.wanted_id WHERE s.author = '${handle}' ORDER BY s.id DESC LIMIT ${limit}`;
      const stampsReceivedSql = `SELECT s.id AS stamp_id, s.author, s.subject, s.valence, s.confidence, s.severity, s.skill_tags, s.message, s.context_id, s.context_type, c.wanted_id, w.title AS wanted_title FROM stamps s LEFT JOIN completions c ON c.id = s.context_id LEFT JOIN wanted w ON w.id = c.wanted_id WHERE s.subject = '${handle}' ORDER BY s.id DESC LIMIT ${limit}`;

      async function runOrEmpty<T>(
        sql: string,
        parser: (rows: unknown[]) => T[],
        label: string
      ): Promise<T[]> {
        try {
          const result = await doltApi.runUnsafeSql(upstream, token, 'main', sql);
          return parser(result.rows ?? []);
        } catch (err) {
          if (err instanceof doltApi.DoltHubApiError) {
            // A missing table (e.g. no stamps yet on a new upstream) shouldn't
            // nuke the whole response. Log the status + label so an empty
            // section doesn't silently hide a real failure.
            if (err.status === 404 || err.status === 400) {
              console.warn(
                `[listRigActivity] ${label} returned ${err.status} (${err.message}); treating as empty`
              );
              return [];
            }
          }
          throw err;
        }
      }

      try {
        const [posted, claimed, completions, stampsAuthored, stampsReceived] = await Promise.all([
          runOrEmpty(postedSql, parseWantedBoardRows, 'posted'),
          runOrEmpty(claimedSql, parseWantedBoardRows, 'claimed'),
          runOrEmpty(
            completionsSql,
            rows => {
              const parsed = z
                .array(
                  z.object({
                    completion_id: z.string(),
                    wanted_id: z.string(),
                    wanted_title: z.string().nullable().default(null),
                    completed_by: z.string().nullable().default(null),
                    evidence: z.string().nullable().default(null),
                    hop_uri: z.string().nullable().default(null),
                    validated_by: z.string().nullable().default(null),
                    stamp_id: z.string().nullable().default(null),
                    completed_at: z.string().nullable().default(null),
                  })
                )
                .safeParse(rows);
              return parsed.success ? parsed.data : [];
            },
            'completions'
          ),
          runOrEmpty(stampsAuthoredSql, rows => parseStampRows(rows), 'stamps_authored'),
          runOrEmpty(stampsReceivedSql, rows => parseStampRows(rows), 'stamps_received'),
        ]);
        return {
          posted,
          claimed,
          completions,
          stamps_authored: stampsAuthored,
          stamps_received: stampsReceived,
        };
      } catch (err) {
        if (err instanceof doltApi.DoltHubApiError) {
          throw new TRPCError({
            code: err.status === 401 || err.status === 403 ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR',
            message: err.message,
          });
        }
        throw err;
      }
    }),

  // ── Admin: Change rig trust level via direct upstream write ─────────
  // `wl` has no CLI command for trust-level changes, so we use the
  // DoltHub write API to update `rigs.trust_level` on a scratch branch,
  // then open + merge a PR to land the change on `main`. The DoltHub
  // REST API has no direct branch→branch merge endpoint; the only way
  // to reach `main` from a scratch branch is via the pulls API.
  // This requires admin write access on the upstream.

  setUpstreamRigTrust: procedure
    .input(
      z.object({
        wastelandId: z.string().uuid(),
        // `wl` rig handles are alphanumeric with `-` or `_`, max 64 chars.
        // Validating at the Zod layer means the SQL interpolation below is
        // safe by construction — the string CANNOT contain quotes, spaces,
        // semicolons, SQL comment markers, or any other injection vector.
        rigHandle: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-zA-Z0-9_-]+$/, 'rigHandle must be alphanumeric with - or _ only'),
        trustLevel: z.number().int().min(0).max(3),
      })
    )
    .output(z.object({ success: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await requireOwnerAccess(ctx.env, ctx, input.wastelandId);
      const { token, upstream, isUpstreamAdmin } = await loadAdminContext(
        ctx.env,
        input.wastelandId,
        ctx.userId
      );
      if (!isUpstreamAdmin) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Admin mode required to change rig trust levels',
        });
      }
      const scratchBranch = `trust-${input.rigHandle}-${crypto.randomUUID().slice(0, 8)}`;
      let orphanedPullId: string | null = null;
      let mergeConfirmed = false;
      try {
        // Step 1: commit the trust-level change on a scratch branch.
        // `rigHandle` is validated by Zod to match /^[a-zA-Z0-9_-]+$/ and
        // `trustLevel` is an integer in [0,3]. Both are safe to interpolate.
        await doltApi.runWrite(
          upstream,
          token,
          'main',
          scratchBranch,
          `UPDATE rigs SET trust_level = ${input.trustLevel} WHERE handle = '${input.rigHandle}'`
        );
        // Step 2: open a PR from scratch → main so the commit can be merged.
        const pull = await doltApi.createPull(upstream, token, {
          title: `[wl] set trust_level=${input.trustLevel} for ${input.rigHandle}`,
          description: 'Automated admin write — rig trust level update.',
          fromBranch: scratchBranch,
          toBranch: 'main',
        });
        orphanedPullId = pull.pullId;
        // Step 3: enqueue the merge. DoltHub's merge is asynchronous — it
        // returns 202 with an `operation_name` that we have to poll.
        const merge = await doltApi.mergePull(upstream, token, orphanedPullId);
        // Step 4: confirm the merge landed on `main` before cleaning up the
        // source branch. Deleting the branch while the worker is still
        // reading it aborts the merge and leaves `main` unchanged. There are
        // two valid confirmation paths:
        //   a) the POST returned a terminal `merged` state (synchronous merge),
        //   b) we have an `operation_name` we can poll to completion.
        // Any other response (e.g. `merging` with no operation_name) is
        // treated as an error: we do not know whether the merge landed, so
        // we leave the PR/branch intact for an operator to inspect.
        if (merge.state === 'merged') {
          mergeConfirmed = true;
        } else if (merge.operationName) {
          const result = await doltApi.waitForMergeCompletion(
            upstream,
            token,
            orphanedPullId,
            merge.operationName
          );
          if (!result.success) {
            throw new TRPCError({
              code: 'INTERNAL_SERVER_ERROR',
              message: `Merge job completed but DoltHub reported failure for pull ${orphanedPullId}`,
            });
          }
          mergeConfirmed = true;
        } else {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: `Merge for pull ${orphanedPullId} returned state=${merge.state} without an operation_name; cannot confirm completion`,
          });
        }
        // Merge landed on `main`. Safe to clean up in `finally` now.
        orphanedPullId = null;
        meterEvent(ctx.env, {
          event: 'billing.api_operation',
          userId: ctx.userId,
          wastelandId: input.wastelandId,
          label: 'rig_trust_update',
        });
        return { success: true };
      } catch (err) {
        if (err instanceof doltApi.DoltHubApiError) {
          throw new TRPCError({
            code: err.status === 401 || err.status === 403 ? 'FORBIDDEN' : 'INTERNAL_SERVER_ERROR',
            message: err.message,
          });
        }
        throw err;
      } finally {
        // Cleanup rules:
        //   1. If `orphanedPullId` is still set, the merge didn't confirm
        //      — close the PR so it doesn't hang around forever.
        //   2. Only delete the scratch branch once the merge has CONFIRMED
        //      on `main` (mergeConfirmed=true). Deleting while the merge
        //      worker is still reading the branch aborts the job and
        //      leaves `main` unchanged. If the merge failed or timed out,
        //      leave the branch so an operator can inspect / retry.
        // Both cleanups are best-effort — failures here don't fail the
        // overall operation.
        if (orphanedPullId) {
          await doltApi.closePull(upstream, token, orphanedPullId).catch(() => {
            // Ignore — the caller's error path likely already handled this.
          });
        }
        if (mergeConfirmed) {
          await doltApi.deleteBranch(upstream, token, scratchBranch).catch(() => {
            // Branch may already be gone (merge deletes source branch on
            // some DoltHub configurations).
          });
        }
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
