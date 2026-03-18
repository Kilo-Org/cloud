/**
 * Gastown tRPC router — served directly by the Gastown worker.
 *
 * This replaces the Next.js proxy layer (src/routers/gastown-router.ts).
 * The worker validates Kilo JWTs directly, resolves user data from
 * Hyperdrive, and calls DO methods without an HTTP intermediary.
 */
/* eslint-disable @typescript-eslint/await-thenable -- DO RPC stubs return Rpc.Promisified which is thenable at runtime */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { router, gastownProcedure, adminProcedure } from './init';
import { getTownDOStub } from '../dos/Town.do';
import { getTownContainerStub } from '../dos/TownContainer.do';
import { getGastownUserStub } from '../dos/GastownUser.do';
import { getGastownOrgStub } from '../dos/GastownOrg.do';
import type { JwtOrgMembership } from '../middleware/auth.middleware';
import { generateKiloApiToken } from '../util/kilo-token.util';
import { resolveSecret } from '../util/secret.util';
import { TownConfigSchema, TownConfigUpdateSchema } from '../types';
import type { UserRigRecord } from '../db/tables/user-rigs.table';
import {
  RpcTownOutput,
  RpcRigOutput,
  RpcBeadOutput,
  RpcAgentOutput,
  RpcBeadEventOutput,
  RpcMayorSendResultOutput,
  RpcMayorStatusOutput,
  RpcStreamTicketOutput,
  RpcPtySessionOutput,
  RpcSlingResultOutput,
  RpcRigDetailOutput,
  RpcConvoyDetailOutput,
  RpcAlarmStatusOutput,
  RpcOrgTownOutput,
} from './schemas';
import type { TRPCContext } from './init';

// rpcSafe wrapper for TownConfigSchema (imported from ../types, not ./schemas)
const RpcTownConfigSchema = z.any().pipe(TownConfigSchema);

// ── Git credential helpers ─────────────────────────────────────────────

/** Extract 'owner/repo' from a GitHub URL, or null if not a GitHub URL. */
function extractGithubRepo(gitUrl: string): string | null {
  const m = gitUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
  return m ? m[1] : null;
}

/** Best-effort refresh of git credentials for a town via the git-token-service. */
async function refreshGitCredentials(
  env: Env,
  townId: string,
  gitUrl: string,
  userId: string,
  orgId?: string
): Promise<void> {
  if (!env.GIT_TOKEN_SERVICE) return;
  const githubRepo = extractGithubRepo(gitUrl);
  if (!githubRepo) return;

  const result = await env.GIT_TOKEN_SERVICE.getTokenForRepo({ githubRepo, userId, orgId });
  if (!result.success) {
    console.warn(`[gastown-trpc] git credential refresh failed: ${result.reason}`);
    return;
  }

  const townStub = getTownDOStub(env, townId);
  await townStub.updateTownConfig({
    git_auth: {
      github_token: result.token,
      platform_integration_id: result.installationId,
    },
  });
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Extract user identity fields from the tRPC context. */
function userFromCtx(ctx: TRPCContext): { id: string; api_token_pepper: string | null } {
  return { id: ctx.userId, api_token_pepper: ctx.apiTokenPepper };
}

/** Look up a user's membership for a specific org from the JWT claims. */
function getOrgMembership(
  memberships: JwtOrgMembership[],
  orgId: string
): JwtOrgMembership | undefined {
  return memberships.find(m => m.orgId === orgId);
}

/** List org IDs where the user has a non-billing_manager role (from JWT). */
function listAccessibleOrgIds(memberships: JwtOrgMembership[]): string[] {
  return memberships.filter(m => m.role !== 'billing_manager').map(m => m.orgId);
}

/**
 * Common interface for the rig/town management methods shared by
 * GastownUserDO and GastownOrgDO stubs. Used to abstract over
 * personal vs org ownership in tRPC procedures.
 */
type RigOwnerStub = {
  listRigs(townId: string): Promise<UserRigRecord[]>;
  createRig(input: {
    town_id: string;
    name: string;
    git_url: string;
    default_branch: string;
    platform_integration_id?: string;
  }): Promise<UserRigRecord>;
  getRigAsync(rigId: string): Promise<UserRigRecord | null>;
  deleteRig(rigId: string): Promise<boolean>;
  deleteTown(townId: string): Promise<boolean>;
};

/**
 * Core ownership resolution shared by resolveRigOwnerStub and verifyTownOwnership.
 * Returns the owning DO stub and, for personal towns, the town record.
 */
async function resolveTownOwnership(
  env: Env,
  userId: string,
  townId: string,
  memberships: JwtOrgMembership[]
): Promise<
  | {
      type: 'user';
      stub: RigOwnerStub;
      town: {
        id: string;
        name: string;
        owner_user_id: string;
        created_at: string;
        updated_at: string;
      };
    }
  | { type: 'org'; stub: RigOwnerStub; orgId: string }
> {
  // Fast path: personal town lookup
  const userStub = getGastownUserStub(env, userId);
  const personalTown = await userStub.getTownAsync(townId);
  if (personalTown) {
    if (personalTown.owner_user_id !== userId) {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
    }
    return { type: 'user', stub: userStub, town: personalTown };
  }

  // Check TownDO config for org ownership, verify via JWT claims
  const townStub = getTownDOStub(env, townId);
  let config;
  try {
    config = await townStub.getTownConfig();
  } catch {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Town not found' });
  }

  if (config.owner_type === 'org' && config.organization_id) {
    const membership = getOrgMembership(memberships, config.organization_id);
    if (!membership || membership.role === 'billing_manager') {
      throw new TRPCError({ code: 'FORBIDDEN', message: 'Not an org member' });
    }
    return {
      type: 'org',
      stub: getGastownOrgStub(env, config.organization_id),
      orgId: config.organization_id,
    };
  }

  throw new TRPCError({ code: 'NOT_FOUND', message: 'Town not found' });
}

/** Resolve the DO stub that owns rigs/towns. Verifies access via JWT claims. */
async function resolveRigOwnerStub(
  env: Env,
  userId: string,
  townId: string,
  memberships: JwtOrgMembership[]
): Promise<RigOwnerStub> {
  const result = await resolveTownOwnership(env, userId, townId, memberships);
  return result.stub;
}

/**
 * Verify that a user has access to a town and return a record matching
 * RpcTownOutput (used by the getTown procedure).
 */
async function verifyTownOwnership(
  env: Env,
  userId: string,
  townId: string,
  memberships: JwtOrgMembership[]
) {
  const result = await resolveTownOwnership(env, userId, townId, memberships);
  if (result.type === 'user') return result.town;

  // Fetch the org town record for name/timestamps
  const orgStub = getGastownOrgStub(env, result.orgId);
  const orgTown = await orgStub.getTownAsync(townId);
  return {
    id: townId,
    name: orgTown?.name ?? townId,
    owner_user_id: orgTown?.created_by_user_id ?? userId,
    created_at: orgTown?.created_at ?? new Date().toISOString(),
    updated_at: orgTown?.updated_at ?? new Date().toISOString(),
  };
}

/**
 * Verify that a user has access to a rig — either through their personal DO
 * or through an org that owns the rig's town (checked via JWT claims).
 */
async function verifyRigOwnership(
  env: Env,
  userId: string,
  rigId: string,
  memberships: JwtOrgMembership[]
) {
  // Fast path: personal rig lookup
  const userStub = getGastownUserStub(env, userId);
  const personalRig = await userStub.getRigAsync(rigId);
  if (personalRig) return personalRig;

  // Check org DOs in parallel (billing_manager excluded)
  const orgIds = listAccessibleOrgIds(memberships);
  if (orgIds.length > 0) {
    const results = await Promise.all(
      orgIds.map(orgId => getGastownOrgStub(env, orgId).getRigAsync(rigId))
    );
    const orgRig = results.find(r => r !== null);
    if (orgRig) return orgRig;
  }

  throw new TRPCError({ code: 'NOT_FOUND', message: 'Rig not found' });
}

async function mintKilocodeToken(env: Env, user: { id: string; api_token_pepper: string | null }) {
  if (!env.NEXTAUTH_SECRET) {
    console.error('[mintKilocodeToken] NEXTAUTH_SECRET not configured');
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
  }
  const secret = await resolveSecret(env.NEXTAUTH_SECRET);
  if (!secret) {
    console.error('[mintKilocodeToken] failed to resolve NEXTAUTH_SECRET from Secrets Store');
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Internal server error',
    });
  }
  return generateKiloApiToken(user, secret);
}

// ── Router ─────────────────────────────────────────────────────────────

export const gastownRouter = router({
  // ── Towns ───────────────────────────────────────────────────────────

  createTown: gastownProcedure
    .input(z.object({ name: z.string().min(1).max(64) }))
    .output(RpcTownOutput)
    .mutation(async ({ ctx, input }) => {
      const user = userFromCtx(ctx);
      const userStub = getGastownUserStub(ctx.env, user.id);
      const town = await userStub.createTown({ name: input.name, owner_user_id: user.id });

      // Store kilocode token so agents can auth with the Kilo LLM gateway
      const kilocodeToken = await mintKilocodeToken(ctx.env, user);
      const townStub = getTownDOStub(ctx.env, town.id);
      await townStub.setTownId(town.id);
      await townStub.updateTownConfig({
        kilocode_token: kilocodeToken,
        owner_user_id: user.id,
      });

      return town;
    }),

  listTowns: gastownProcedure.output(z.array(RpcTownOutput)).query(async ({ ctx }) => {
    const userStub = getGastownUserStub(ctx.env, ctx.userId);
    return userStub.listTowns();
  }),

  getTown: gastownProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(RpcTownOutput)
    .query(async ({ ctx, input }) => {
      return verifyTownOwnership(ctx.env, ctx.userId, input.townId, ctx.orgMemberships);
    }),

  deleteTown: gastownProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ownership = await resolveTownOwnership(
        ctx.env,
        ctx.userId,
        input.townId,
        ctx.orgMemberships
      );
      if (ownership.type === 'org') {
        const membership = getOrgMembership(ctx.orgMemberships, ownership.orgId);
        if (!membership || membership.role !== 'owner') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only org owners can delete towns' });
        }
      }
      const ownerStub = ownership.stub;

      // Destroy the Town DO (agents, container, alarms, storage).
      // Let failures propagate — if cleanup fails, don't delete the
      // user record (that's the only reference for recovering the
      // leaked resources).
      const townDOStub = getTownDOStub(ctx.env, input.townId);
      await townDOStub.destroy();

      await ownerStub.deleteTown(input.townId);
    }),

  // ── Rigs ────────────────────────────────────────────────────────────

  createRig: gastownProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        name: z.string().min(1).max(64),
        gitUrl: z.string().url(),
        defaultBranch: z.string().default('main'),
        platformIntegrationId: z.string().uuid().optional(),
      })
    )
    .output(RpcRigOutput)
    .mutation(async ({ ctx, input }) => {
      const user = userFromCtx(ctx);
      const ownership = await resolveTownOwnership(
        ctx.env,
        user.id,
        input.townId,
        ctx.orgMemberships
      );
      const ownerStub = ownership.stub;

      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.setTownId(input.townId);

      // For org towns, use the town owner's identity for credentials;
      // for personal towns the caller is always the owner.
      const townConfig = await townStub.getTownConfig();
      const credentialUserId = townConfig.owner_user_id ?? user.id;

      // Only re-mint kilocode token if the caller is the owner (they
      // have their own api_token_pepper in ctx). For org towns where
      // a non-owner member adds a rig, keep the existing town token.
      let kilocodeToken: string | undefined;
      if (credentialUserId === user.id) {
        kilocodeToken = await mintKilocodeToken(ctx.env, user);
        await townStub.updateTownConfig({ kilocode_token: kilocodeToken });
      }

      // Resolve git credentials using the town owner's identity
      try {
        await refreshGitCredentials(
          ctx.env,
          input.townId,
          input.gitUrl,
          credentialUserId,
          townConfig.organization_id
        );
      } catch (err) {
        console.warn('[gastown-trpc] createRig: git credential refresh failed', err);
      }

      const rig = await ownerStub.createRig({
        town_id: input.townId,
        name: input.name,
        git_url: input.gitUrl,
        default_branch: input.defaultBranch,
        platform_integration_id: input.platformIntegrationId,
      });

      // Configure the Town DO with rig metadata so dispatchAgent can find it.
      // If this fails, roll back the rig creation to avoid an orphaned record.
      try {
        await townStub.configureRig({
          rigId: rig.id,
          townId: input.townId,
          gitUrl: input.gitUrl,
          defaultBranch: input.defaultBranch,
          userId: credentialUserId,
          kilocodeToken,
          platformIntegrationId: input.platformIntegrationId,
        });
        await townStub.addRig({
          rigId: rig.id,
          name: input.name,
          gitUrl: input.gitUrl,
          defaultBranch: input.defaultBranch,
        });
      } catch (err) {
        console.error(
          `[gastown-trpc] createRig: Town DO configure FAILED for rig ${rig.id}, rolling back:`,
          err
        );
        try {
          await ownerStub.deleteRig(rig.id);
        } catch {
          /* best effort rollback */
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to configure rig' });
      }

      return rig;
    }),

  listRigs: gastownProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(z.array(RpcRigOutput))
    .query(async ({ ctx, input }) => {
      const ownerStub = await resolveRigOwnerStub(
        ctx.env,
        ctx.userId,
        input.townId,
        ctx.orgMemberships
      );
      return ownerStub.listRigs(input.townId);
    }),

  getRig: gastownProcedure
    .input(z.object({ rigId: z.string().uuid() }))
    .output(RpcRigDetailOutput)
    .query(async ({ ctx, input }) => {
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, rig.town_id);
      // Sequential to avoid "excessively deep" type inference with Rpc.Promisified DO stubs.
      const agentList = await townStub.listAgents({ rig_id: rig.id });
      const beadList = await townStub.listBeads({ rig_id: rig.id, status: 'in_progress' });
      return { ...rig, agents: agentList, beads: beadList };
    }),

  deleteRig: gastownProcedure
    .input(z.object({ rigId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId, ctx.orgMemberships);
      const ownership = await resolveTownOwnership(
        ctx.env,
        ctx.userId,
        rig.town_id,
        ctx.orgMemberships
      );
      if (ownership.type === 'org') {
        const membership = getOrgMembership(ctx.orgMemberships, ownership.orgId);
        if (!membership || membership.role !== 'owner') {
          throw new TRPCError({ code: 'FORBIDDEN', message: 'Only org owners can delete rigs' });
        }
      }
      // Remove from Town DO first so the name is freed before the owner
      // record is deleted. If this fails the owner record is still intact
      // and the user can retry.
      const townStub = getTownDOStub(ctx.env, rig.town_id);
      await townStub.removeRig(input.rigId);
      const ownerStub = ownership.stub;
      await ownerStub.deleteRig(input.rigId);
    }),

  // ── Beads ───────────────────────────────────────────────────────────

  listBeads: gastownProcedure
    .input(
      z.object({
        rigId: z.string().uuid(),
        status: z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']).optional(),
      })
    )
    .output(z.array(RpcBeadOutput))
    .query(async ({ ctx, input }) => {
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, rig.town_id);
      return townStub.listBeads({ rig_id: rig.id, status: input.status });
    }),

  deleteBead: gastownProcedure
    .input(z.object({ rigId: z.string().uuid(), beadId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, rig.town_id);
      await townStub.deleteBead(input.beadId);
    }),

  updateBead: gastownProcedure
    .input(
      z
        .object({
          rigId: z.string().uuid(),
          beadId: z.string().uuid(),
          title: z.string().min(1).optional(),
          body: z.string().nullable().optional(),
          status: z.enum(['open', 'in_progress', 'in_review', 'closed', 'failed']).optional(),
          priority: z.enum(['low', 'medium', 'high', 'critical']).optional(),
          labels: z.array(z.string()).optional(),
          metadata: z.record(z.string(), z.unknown()).optional(),
          rig_id: z.string().min(1).nullable().optional(),
          parent_bead_id: z.string().min(1).nullable().optional(),
        })
        .refine(
          data =>
            data.title !== undefined ||
            data.body !== undefined ||
            data.status !== undefined ||
            data.priority !== undefined ||
            data.labels !== undefined ||
            data.metadata !== undefined ||
            data.rig_id !== undefined ||
            data.parent_bead_id !== undefined,
          { message: 'At least one field to update must be provided' }
        )
    )
    .output(RpcBeadOutput)
    .mutation(async ({ ctx, input }) => {
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, rig.town_id);

      // Verify the bead belongs to this rig
      const existing = await townStub.getBeadAsync(input.beadId);
      if (!existing) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Bead not found' });
      }
      if (existing.rig_id !== input.rigId) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Bead does not belong to this rig' });
      }

      const { rigId: _rigId, beadId, ...fields } = input;
      return townStub.updateBead(beadId, fields, ctx.userId);
    }),

  // ── Agents ──────────────────────────────────────────────────────────

  listAgents: gastownProcedure
    .input(z.object({ rigId: z.string().uuid() }))
    .output(z.array(RpcAgentOutput))
    .query(async ({ ctx, input }) => {
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, rig.town_id);
      return townStub.listAgents({ rig_id: rig.id });
    }),

  deleteAgent: gastownProcedure
    .input(z.object({ rigId: z.string().uuid(), agentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, rig.town_id);
      await townStub.deleteAgent(input.agentId);
    }),

  // ── Work Assignment ─────────────────────────────────────────────────

  sling: gastownProcedure
    .input(
      z.object({
        rigId: z.string().uuid(),
        title: z.string().min(1),
        body: z.string().optional(),
        model: z.string().default('kilo/kilo-auto/frontier'),
      })
    )
    .output(RpcSlingResultOutput)
    .mutation(async ({ ctx, input }) => {
      const user = userFromCtx(ctx);
      const rig = await verifyRigOwnership(ctx.env, user.id, input.rigId, ctx.orgMemberships);

      // Best-effort: refresh git credentials using the town owner's identity
      const townConfig = await getTownDOStub(ctx.env, rig.town_id).getTownConfig();
      const credentialUserId = townConfig.owner_user_id ?? user.id;
      try {
        await refreshGitCredentials(
          ctx.env,
          rig.town_id,
          rig.git_url,
          credentialUserId,
          townConfig.organization_id
        );
      } catch (err) {
        console.warn('[gastown-trpc] sling: git credential refresh failed', err);
      }

      const townStub = getTownDOStub(ctx.env, rig.town_id);
      await townStub.setTownId(rig.town_id);
      return townStub.slingBead({
        rigId: rig.id,
        title: input.title,
        body: input.body,
        metadata: { model: input.model, slung_by: user.id },
      });
    }),

  // ── Mayor ───────────────────────────────────────────────────────────

  sendMessage: gastownProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        message: z.string().min(1),
        model: z.string().default('anthropic/claude-sonnet-4.6'),
        rigId: z.string().uuid().optional(),
        uiContext: z.string().max(10_000).optional(),
      })
    )
    .output(RpcMayorSendResultOutput)
    .mutation(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId, ctx.orgMemberships);

      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.setTownId(input.townId);
      return townStub.sendMayorMessage(input.message, input.model, input.uiContext);
    }),

  getMayorStatus: gastownProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(RpcMayorStatusOutput)
    .query(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.setTownId(input.townId);
      return townStub.getMayorStatus();
    }),

  getAlarmStatus: gastownProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(RpcAlarmStatusOutput)
    .query(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.setTownId(input.townId);
      return townStub.getAlarmStatus();
    }),

  ensureMayor: gastownProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(RpcMayorSendResultOutput)
    .mutation(async ({ ctx, input }) => {
      const ownerStub = await resolveRigOwnerStub(
        ctx.env,
        ctx.userId,
        input.townId,
        ctx.orgMemberships
      );

      // Best-effort: refresh git credentials using the town owner's identity
      const townConfig = await getTownDOStub(ctx.env, input.townId).getTownConfig();
      const credentialUserId = townConfig.owner_user_id ?? ctx.userId;
      try {
        const rigList = await ownerStub.listRigs(input.townId);
        for (const rig of rigList) {
          if (extractGithubRepo(rig.git_url)) {
            await refreshGitCredentials(
              ctx.env,
              input.townId,
              rig.git_url,
              credentialUserId,
              townConfig.organization_id
            );
            break;
          }
        }
      } catch (err) {
        console.warn('[gastown-trpc] ensureMayor: git credential refresh failed', err);
      }

      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.setTownId(input.townId);
      return townStub.ensureMayor();
    }),

  // ── Agent Streams ───────────────────────────────────────────────────

  getAgentStreamUrl: gastownProcedure
    .input(z.object({ agentId: z.string().uuid(), townId: z.string().uuid() }))
    .output(RpcStreamTicketOutput)
    .query(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId, ctx.orgMemberships);

      // Proxy to container control server to get a stream ticket
      const containerStub = getTownContainerStub(ctx.env, input.townId);
      const response = await containerStub.fetch(
        `http://container/agents/${input.agentId}/stream-ticket`,
        { method: 'POST' }
      );
      if (!response.ok) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Container error: ${response.status}`,
        });
      }
      const raw: unknown = await response.json();
      const ticketData = z.object({ ticket: z.string() }).parse(raw);

      // Return a relative path — the frontend constructs the full WS URL
      // using its known GASTOWN_URL (avoids Docker-internal vs browser URL mismatch).
      const url = `/api/towns/${input.townId}/container/agents/${input.agentId}/stream`;

      return { url, ticket: ticketData.ticket };
    }),

  // ── PTY ─────────────────────────────────────────────────────────────

  createPtySession: gastownProcedure
    .input(z.object({ townId: z.string().uuid(), agentId: z.string().uuid() }))
    .output(RpcPtySessionOutput)
    .mutation(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId, ctx.orgMemberships);

      // Proxy to container control server to create a PTY session
      const containerStub = getTownContainerStub(ctx.env, input.townId);
      const response = await containerStub.fetch(`http://container/agents/${input.agentId}/pty`, {
        method: 'POST',
        body: '{}',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!response.ok) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Container error: ${response.status}`,
        });
      }
      const pty: unknown = await response.json();
      const ptyData = z.object({ id: z.string() }).passthrough().parse(pty);

      // Return a relative path — the frontend constructs the full WS URL
      // using its known GASTOWN_URL (avoids Docker-internal vs browser URL mismatch).
      const wsUrl = `/api/towns/${input.townId}/container/agents/${input.agentId}/pty/${ptyData.id}/connect`;

      return { pty: ptyData, wsUrl };
    }),

  resizePtySession: gastownProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        agentId: z.string().uuid(),
        ptyId: z.string().regex(/^[a-zA-Z0-9_-]+$/, 'Invalid ptyId'),
        cols: z.number().int().min(1).max(500),
        rows: z.number().int().min(1).max(200),
      })
    )
    .mutation(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId, ctx.orgMemberships);

      const containerStub = getTownContainerStub(ctx.env, input.townId);
      const response = await containerStub.fetch(
        `http://container/agents/${input.agentId}/pty/${input.ptyId}`,
        {
          method: 'PUT',
          body: JSON.stringify({ size: { cols: input.cols, rows: input.rows } }),
          headers: { 'Content-Type': 'application/json' },
        }
      );
      if (!response.ok) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: `Container error: ${response.status}`,
        });
      }
    }),

  // ── Town Configuration ──────────────────────────────────────────────

  getTownConfig: gastownProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(RpcTownConfigSchema)
    .query(async ({ ctx, input }) => {
      const ownership = await resolveTownOwnership(
        ctx.env,
        ctx.userId,
        input.townId,
        ctx.orgMemberships
      );
      const townStub = getTownDOStub(ctx.env, input.townId);
      const config = await townStub.getTownConfig();

      // Mask secrets for non-owner org members
      if (ownership.type === 'org') {
        const membership = getOrgMembership(ctx.orgMemberships, ownership.orgId);
        if (membership?.role !== 'owner') {
          const mask = (s?: string) => (s ? '****' + s.slice(-4) : undefined);
          return {
            ...config,
            kilocode_token: mask(config.kilocode_token),
            github_cli_pat: mask(config.github_cli_pat),
            git_auth: {
              ...config.git_auth,
              github_token: mask(config.git_auth?.github_token),
              gitlab_token: mask(config.git_auth?.gitlab_token),
            },
            env_vars: Object.fromEntries(
              Object.entries(config.env_vars).map(([k, v]) => [k, '****' + v.slice(-4)])
            ),
          };
        }
      }

      return config;
    }),

  updateTownConfig: gastownProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        config: TownConfigUpdateSchema,
      })
    )
    .output(RpcTownConfigSchema)
    .mutation(async ({ ctx, input }) => {
      const ownership = await resolveTownOwnership(
        ctx.env,
        ctx.userId,
        input.townId,
        ctx.orgMemberships
      );

      // Strip ownership fields — only the system (createTown flows) should set these
      const {
        owner_user_id: _a,
        owner_type: _b,
        owner_id: _c,
        organization_id: _d,
        created_by_user_id: _e,
        ...safeConfig
      } = input.config;

      // For org towns, only owners can update config
      if (ownership.type === 'org') {
        const membership = getOrgMembership(ctx.orgMemberships, ownership.orgId);
        if (!membership || membership.role !== 'owner') {
          throw new TRPCError({
            code: 'FORBIDDEN',
            message: 'Only org owners can update town config',
          });
        }
      }

      const townStub = getTownDOStub(ctx.env, input.townId);
      const result = await townStub.updateTownConfig(safeConfig);

      // Push updated env vars to the running container so changes
      // take effect without a container restart
      try {
        await townStub.syncConfigToContainer();
      } catch (err) {
        console.warn('[gastown-trpc] updateTownConfig: syncConfigToContainer failed:', err);
      }

      return result;
    }),

  refreshContainerToken: gastownProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.setTownId(input.townId);
      await townStub.forceRefreshContainerToken();
    }),

  // ── Events ──────────────────────────────────────────────────────────

  getBeadEvents: gastownProcedure
    .input(
      z.object({
        rigId: z.string().uuid(),
        beadId: z.string().uuid().optional(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .output(z.array(RpcBeadEventOutput))
    .query(async ({ ctx, input }) => {
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, rig.town_id);
      return townStub.listBeadEvents({
        beadId: input.beadId,
        since: input.since,
        limit: input.limit,
      });
    }),

  getTownEvents: gastownProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .output(z.array(RpcBeadEventOutput))
    .query(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, input.townId);
      return townStub.listBeadEvents({
        since: input.since,
        limit: input.limit,
      });
    }),

  listConvoys: gastownProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
      })
    )
    .output(z.array(RpcConvoyDetailOutput))
    .query(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, input.townId);
      return townStub.listConvoysDetailed();
    }),

  getConvoy: gastownProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        convoyId: z.string().uuid(),
      })
    )
    .output(RpcConvoyDetailOutput.nullable())
    .query(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, input.townId);
      return townStub.getConvoyStatus(input.convoyId);
    }),

  closeConvoy: gastownProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        convoyId: z.string().uuid(),
      })
    )
    .output(RpcConvoyDetailOutput.nullable())
    .mutation(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, input.townId);
      const convoy = await townStub.closeConvoy(input.convoyId);
      if (!convoy) return null;
      const status = await townStub.getConvoyStatus(input.convoyId);
      return status ?? { ...convoy, beads: [] };
    }),

  startConvoy: gastownProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        convoyId: z.string().uuid(),
      })
    )
    .output(RpcConvoyDetailOutput.nullable())
    .mutation(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId, ctx.orgMemberships);
      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.startConvoy(input.convoyId);
      const status = await townStub.getConvoyStatus(input.convoyId);
      return status ?? null;
    }),

  // ── Org Towns & Rigs ────────────────────────────────────────────────

  listOrgTowns: gastownProcedure
    .input(z.object({ organizationId: z.string().uuid() }))
    .output(z.array(RpcOrgTownOutput))
    .query(async ({ input, ctx }) => {
      const membership = getOrgMembership(ctx.orgMemberships, input.organizationId);
      if (!membership || membership.role === 'billing_manager')
        throw new TRPCError({ code: 'FORBIDDEN' });
      const stub = getGastownOrgStub(ctx.env, input.organizationId);
      return stub.listTowns();
    }),

  createOrgTown: gastownProcedure
    .input(z.object({ organizationId: z.string().uuid(), name: z.string().min(1).max(64) }))
    .output(RpcOrgTownOutput)
    .mutation(async ({ input, ctx }) => {
      const membership = getOrgMembership(ctx.orgMemberships, input.organizationId);
      if (!membership || membership.role === 'billing_manager')
        throw new TRPCError({ code: 'FORBIDDEN' });
      const stub = getGastownOrgStub(ctx.env, input.organizationId);
      const town = await stub.createTown({
        name: input.name,
        owner_org_id: input.organizationId,
        created_by_user_id: ctx.userId,
      });

      // Mint kilocode token so the mayor can start without waiting for rig creation
      const user = userFromCtx(ctx);
      const kilocodeToken = await mintKilocodeToken(ctx.env, user);

      const townStub = getTownDOStub(ctx.env, town.id);
      await townStub.setTownId(town.id);
      await townStub.updateTownConfig({
        kilocode_token: kilocodeToken,
        owner_type: 'org',
        owner_id: input.organizationId,
        owner_user_id: ctx.userId,
        organization_id: input.organizationId,
        created_by_user_id: ctx.userId,
      });

      return town;
    }),

  deleteOrgTown: gastownProcedure
    .input(z.object({ organizationId: z.string().uuid(), townId: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      const membership = getOrgMembership(ctx.orgMemberships, input.organizationId);
      if (!membership || membership.role !== 'owner') throw new TRPCError({ code: 'FORBIDDEN' });
      const stub = getGastownOrgStub(ctx.env, input.organizationId);
      const town = await stub.getTownAsync(input.townId);
      if (!town) throw new TRPCError({ code: 'NOT_FOUND', message: 'Town not found' });

      // Destroy the Town DO (handles all rigs, agents, and mayor cleanup)
      try {
        const townStub = getTownDOStub(ctx.env, input.townId);
        await townStub.destroy();
      } catch (err) {
        console.error(
          `[gastown-trpc] deleteOrgTown: failed to destroy Town DO for ${input.townId}:`,
          err
        );
      }

      await stub.deleteTown(input.townId);
    }),

  listOrgRigs: gastownProcedure
    .input(z.object({ organizationId: z.string().uuid(), townId: z.string().uuid() }))
    .output(z.array(RpcRigOutput))
    .query(async ({ input, ctx }) => {
      const membership = getOrgMembership(ctx.orgMemberships, input.organizationId);
      if (!membership || membership.role === 'billing_manager')
        throw new TRPCError({ code: 'FORBIDDEN' });
      const stub = getGastownOrgStub(ctx.env, input.organizationId);
      const town = await stub.getTownAsync(input.townId);
      if (!town) throw new TRPCError({ code: 'NOT_FOUND', message: 'Town not found' });
      return stub.listRigs(input.townId);
    }),

  createOrgRig: gastownProcedure
    .input(
      z.object({
        organizationId: z.string().uuid(),
        townId: z.string().uuid(),
        name: z.string().min(1).max(64),
        gitUrl: z.string().url(),
        defaultBranch: z.string().default('main'),
        platformIntegrationId: z.string().uuid().optional(),
      })
    )
    .output(RpcRigOutput)
    .mutation(async ({ input, ctx }) => {
      const membership = getOrgMembership(ctx.orgMemberships, input.organizationId);
      if (!membership || membership.role === 'billing_manager')
        throw new TRPCError({ code: 'FORBIDDEN' });

      const orgStub = getGastownOrgStub(ctx.env, input.organizationId);
      const town = await orgStub.getTownAsync(input.townId);
      if (!town) throw new TRPCError({ code: 'NOT_FOUND', message: 'Town not found' });

      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.setTownId(input.townId);

      // Use the town owner's identity for credentials. Only re-mint the
      // kilocode token if the caller is the owner (they have their pepper
      // in ctx). For non-owner members, keep the existing town token.
      const townConfig = await townStub.getTownConfig();
      const credentialUserId = townConfig.owner_user_id ?? ctx.userId;
      let kilocodeToken: string | undefined;
      if (credentialUserId === ctx.userId) {
        kilocodeToken = await mintKilocodeToken(ctx.env, userFromCtx(ctx));
        await townStub.updateTownConfig({ kilocode_token: kilocodeToken });
      }

      // Resolve git credentials using the town owner's identity
      try {
        await refreshGitCredentials(
          ctx.env,
          input.townId,
          input.gitUrl,
          credentialUserId,
          townConfig.organization_id
        );
      } catch (err) {
        console.warn('[gastown-trpc] createOrgRig: git credential refresh failed', err);
      }

      const rig = await orgStub.createRig({
        town_id: input.townId,
        name: input.name,
        git_url: input.gitUrl,
        default_branch: input.defaultBranch,
        platform_integration_id: input.platformIntegrationId,
      });

      try {
        await townStub.configureRig({
          rigId: rig.id,
          townId: input.townId,
          gitUrl: input.gitUrl,
          defaultBranch: input.defaultBranch,
          userId: credentialUserId,
          kilocodeToken,
          platformIntegrationId: input.platformIntegrationId,
        });
        await townStub.addRig({
          rigId: rig.id,
          name: input.name,
          gitUrl: input.gitUrl,
          defaultBranch: input.defaultBranch,
        });
      } catch (err) {
        console.error(
          `[gastown-trpc] createOrgRig: Town DO configure FAILED for rig ${rig.id}, rolling back:`,
          err
        );
        try {
          await orgStub.deleteRig(rig.id);
        } catch {
          /* best effort rollback */
        }
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Failed to configure rig' });
      }

      return rig;
    }),

  // ── Admin-only routes (bypass ownership checks) ──────────────────────

  adminListBeads: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        status: z.enum(['open', 'in_progress', 'closed', 'failed']).optional(),
        type: z
          .enum(['issue', 'message', 'escalation', 'merge_request', 'convoy', 'molecule', 'agent'])
          .optional(),
        limit: z.number().int().positive().max(500).default(200),
      })
    )
    .output(z.array(RpcBeadOutput))
    .query(async ({ ctx, input }) => {
      const townStub = getTownDOStub(ctx.env, input.townId);
      return townStub.listBeads({
        status: input.status,
        type: input.type,
        limit: input.limit,
      });
    }),

  adminListAgents: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(z.array(RpcAgentOutput))
    .query(async ({ ctx, input }) => {
      const townStub = getTownDOStub(ctx.env, input.townId);
      return townStub.listAgents({});
    }),

  adminForceRestartContainer: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const containerStub = getTownContainerStub(ctx.env, input.townId);
      await containerStub.destroy();
    }),

  adminForceResetAgent: adminProcedure
    .input(z.object({ townId: z.string().uuid(), agentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.unhookBead(input.agentId);
      await townStub.updateAgentStatus(input.agentId, 'idle');
    }),

  adminForceCloseBead: adminProcedure
    .input(z.object({ townId: z.string().uuid(), beadId: z.string().uuid() }))
    .output(RpcBeadOutput)
    .mutation(async ({ ctx, input }) => {
      const townStub = getTownDOStub(ctx.env, input.townId);
      return townStub.closeBead(input.beadId, 'admin');
    }),

  adminForceFailBead: adminProcedure
    .input(z.object({ townId: z.string().uuid(), beadId: z.string().uuid() }))
    .output(RpcBeadOutput)
    .mutation(async ({ ctx, input }) => {
      const townStub = getTownDOStub(ctx.env, input.townId);
      return townStub.updateBeadStatus(input.beadId, 'failed', 'admin');
    }),

  adminGetAlarmStatus: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(RpcAlarmStatusOutput)
    .query(async ({ ctx, input }) => {
      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.setTownId(input.townId);
      return townStub.getAlarmStatus();
    }),

  adminGetTownEvents: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        beadId: z.string().uuid().optional(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .output(z.array(RpcBeadEventOutput))
    .query(async ({ ctx, input }) => {
      const townStub = getTownDOStub(ctx.env, input.townId);
      return townStub.listBeadEvents({
        beadId: input.beadId,
        since: input.since,
        limit: input.limit,
      });
    }),

  adminGetBead: adminProcedure
    .input(z.object({ townId: z.string().uuid(), beadId: z.string().uuid() }))
    .output(RpcBeadOutput.nullable())
    .query(async ({ ctx, input }) => {
      const townStub = getTownDOStub(ctx.env, input.townId);
      return townStub.getBeadAsync(input.beadId);
    }),
});

export type GastownRouter = typeof gastownRouter;

/**
 * Wrapped router that nests gastownRouter under a `gastown` key.
 * This preserves the `trpc.gastown.X` call pattern on the frontend,
 * matching the existing RootRouter shape so components don't need
 * to change their procedure paths.
 */
export const wrappedGastownRouter = router({ gastown: gastownRouter });
export type WrappedGastownRouter = typeof wrappedGastownRouter;
