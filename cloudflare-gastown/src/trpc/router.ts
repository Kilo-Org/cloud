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
import { generateKiloApiToken } from '../util/kilo-token.util';
import { resolveSecret } from '../util/secret.util';
import { TownConfigSchema, TownConfigUpdateSchema } from '../types';
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
  userId: string
): Promise<void> {
  if (!env.GIT_TOKEN_SERVICE) return;
  const githubRepo = extractGithubRepo(gitUrl);
  if (!githubRepo) return;

  const result = await env.GIT_TOKEN_SERVICE.getTokenForRepo({ githubRepo, userId });
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

async function verifyTownOwnership(env: Env, userId: string, townId: string) {
  const userStub = getGastownUserStub(env, userId);
  const town = await userStub.getTownAsync(townId);
  if (!town) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Town not found' });
  }
  if (town.owner_user_id !== userId) {
    throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
  }
  return town;
}

async function verifyRigOwnership(env: Env, userId: string, rigId: string) {
  const userStub = getGastownUserStub(env, userId);
  const rig = await userStub.getRigAsync(rigId);
  if (!rig) {
    throw new TRPCError({ code: 'NOT_FOUND', message: 'Rig not found' });
  }
  return rig;
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
      return verifyTownOwnership(ctx.env, ctx.userId, input.townId);
    }),

  deleteTown: gastownProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);
      const userStub = getGastownUserStub(ctx.env, ctx.userId);
      await userStub.deleteTown(input.townId);
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
      await verifyTownOwnership(ctx.env, user.id, input.townId);

      // Generate kilocode token for agent LLM gateway auth
      const kilocodeToken = await mintKilocodeToken(ctx.env, user);

      // Store token on town config (used by container dispatch)
      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.setTownId(input.townId);
      await townStub.updateTownConfig({ kilocode_token: kilocodeToken });

      // Resolve git credentials BEFORE configureRig so that
      // townConfig.git_auth.github_token is populated when
      // setupRigRepoInContainer reads it for the proactive clone.
      try {
        await refreshGitCredentials(ctx.env, input.townId, input.gitUrl, user.id);
      } catch (err) {
        console.warn('[gastown-trpc] createRig: git credential refresh failed', err);
      }

      const userStub = getGastownUserStub(ctx.env, user.id);
      const rig = await userStub.createRig({
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
          userId: user.id,
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
          await userStub.deleteRig(rig.id);
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
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);
      const userStub = getGastownUserStub(ctx.env, ctx.userId);
      return userStub.listRigs(input.townId);
    }),

  getRig: gastownProcedure
    .input(z.object({ rigId: z.string().uuid() }))
    .output(RpcRigDetailOutput)
    .query(async ({ ctx, input }) => {
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId);
      const townStub = getTownDOStub(ctx.env, rig.town_id);
      // Sequential to avoid "excessively deep" type inference with Rpc.Promisified DO stubs.
      const agentList = await townStub.listAgents({ rig_id: rig.id });
      const beadList = await townStub.listBeads({ rig_id: rig.id, status: 'in_progress' });
      return { ...rig, agents: agentList, beads: beadList };
    }),

  deleteRig: gastownProcedure
    .input(z.object({ rigId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId);
      // Remove from Town DO first so the name is freed before the user
      // record is deleted. If this fails the user record is still intact
      // and the user can retry.
      const townStub = getTownDOStub(ctx.env, rig.town_id);
      await townStub.removeRig(input.rigId);
      const userStub = getGastownUserStub(ctx.env, ctx.userId);
      await userStub.deleteRig(input.rigId);
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
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId);
      const townStub = getTownDOStub(ctx.env, rig.town_id);
      return townStub.listBeads({ rig_id: rig.id, status: input.status });
    }),

  deleteBead: gastownProcedure
    .input(z.object({ rigId: z.string().uuid(), beadId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId);
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
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId);
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
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId);
      const townStub = getTownDOStub(ctx.env, rig.town_id);
      return townStub.listAgents({ rig_id: rig.id });
    }),

  deleteAgent: gastownProcedure
    .input(z.object({ rigId: z.string().uuid(), agentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId);
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
      const rig = await verifyRigOwnership(ctx.env, user.id, input.rigId);

      // Best-effort: refresh git credentials before dispatching
      try {
        await refreshGitCredentials(ctx.env, rig.town_id, rig.git_url, user.id);
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
      })
    )
    .output(RpcMayorSendResultOutput)
    .mutation(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);

      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.setTownId(input.townId);
      return townStub.sendMayorMessage(input.message, input.model);
    }),

  getMayorStatus: gastownProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(RpcMayorStatusOutput)
    .query(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);
      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.setTownId(input.townId);
      return townStub.getMayorStatus();
    }),

  getAlarmStatus: gastownProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(RpcAlarmStatusOutput)
    .query(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);
      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.setTownId(input.townId);
      return townStub.getAlarmStatus();
    }),

  ensureMayor: gastownProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .output(RpcMayorSendResultOutput)
    .mutation(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);

      // Best-effort: refresh git credentials from the first rig with a GitHub URL
      try {
        const userStub = getGastownUserStub(ctx.env, ctx.userId);
        const rigList = await userStub.listRigs(input.townId);
        for (const rig of rigList) {
          if (extractGithubRepo(rig.git_url)) {
            await refreshGitCredentials(ctx.env, input.townId, rig.git_url, ctx.userId);
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
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);

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
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);

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
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);

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
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);
      const townStub = getTownDOStub(ctx.env, input.townId);
      return townStub.getTownConfig();
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
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);
      const townStub = getTownDOStub(ctx.env, input.townId);
      return townStub.updateTownConfig(input.config);
    }),

  refreshContainerToken: gastownProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);
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
      const rig = await verifyRigOwnership(ctx.env, ctx.userId, input.rigId);
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
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);
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
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);
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
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);
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
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);
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
      await verifyTownOwnership(ctx.env, ctx.userId, input.townId);
      const townStub = getTownDOStub(ctx.env, input.townId);
      await townStub.startConvoy(input.convoyId);
      const status = await townStub.getConvoyStatus(input.convoyId);
      return status ?? null;
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
