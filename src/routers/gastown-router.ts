import 'server-only';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import * as gastown from '@/lib/gastown/gastown-client';
import { GastownApiError } from '@/lib/gastown/gastown-client';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { GASTOWN_SERVICE_URL } from '@/lib/config.server';
import {
  resolveGitCredentialsFromIntegration,
  resolveIntegrationIdFromGitUrl,
  refreshGitCredentials,
} from '@/lib/gastown/git-credentials';

const LOG_PREFIX = '[gastown-router]';

/**
 * Refresh git credentials for a town, writing fresh tokens to the town config.
 * Looks up the platform_integration_id from the town config first, falling
 * back to the first rig that has one. This handles the case where createRig
 * failed to write credentials to the town config initially.
 */
async function refreshTownGitCredentials(townId: string, userId: string): Promise<void> {
  const townConfig = await withGastownError(() => gastown.getTownConfig(townId));
  let integrationId = townConfig.git_auth.platform_integration_id;

  console.log(
    `${LOG_PREFIX} refreshTownGitCredentials: town=${townId} configIntegration=${integrationId ?? 'none'} git_auth_keys=[${Object.entries(
      townConfig.git_auth
    )
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(',')}]`
  );

  if (!integrationId) {
    const rigList = await withGastownError(() => gastown.listRigs(userId, townId));
    console.log(
      `${LOG_PREFIX} refreshTownGitCredentials: checking ${rigList.length} rigs for platform_integration_id: ${rigList.map(r => `${r.id}=${r.platform_integration_id ?? 'null'}`).join(', ')}`
    );
    const rigWithIntegration = rigList.find(r => r.platform_integration_id);
    if (rigWithIntegration) {
      integrationId = rigWithIntegration.platform_integration_id ?? undefined;
    }
  }

  if (!integrationId) {
    console.warn(
      `${LOG_PREFIX} refreshTownGitCredentials: no platform_integration_id found for town=${townId} — git credentials will not be refreshed`
    );
    return;
  }

  console.log(
    `${LOG_PREFIX} refreshTownGitCredentials: refreshing credentials for integration=${integrationId}`
  );
  const freshCredentials = await refreshGitCredentials(integrationId);
  if (freshCredentials) {
    await withGastownError(() =>
      gastown.updateTownConfig(townId, {
        git_auth: {
          ...freshCredentials,
          platform_integration_id: integrationId,
        },
      })
    );
    console.log(
      `${LOG_PREFIX} refreshTownGitCredentials: wrote fresh credentials for town=${townId} hasGithub=${!!freshCredentials.github_token} hasGitlab=${!!freshCredentials.gitlab_token}`
    );
  } else {
    console.warn(
      `${LOG_PREFIX} refreshTownGitCredentials: refreshGitCredentials returned null for integration=${integrationId}`
    );
  }
}

/**
 * Wraps a gastown client call and converts GastownApiError into TRPCError
 * with an appropriate code.
 */
async function withGastownError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GastownApiError) {
      console.error(`${LOG_PREFIX} GastownApiError: status=${err.status} message="${err.message}"`);
      const code =
        err.status === 404
          ? 'NOT_FOUND'
          : err.status === 400
            ? 'BAD_REQUEST'
            : err.status === 403
              ? 'FORBIDDEN'
              : 'INTERNAL_SERVER_ERROR';
      throw new TRPCError({ code, message: err.message });
    }
    console.error(`${LOG_PREFIX} Unexpected error:`, err);
    throw err;
  }
}

export const gastownRouter = createTRPCRouter({
  // ── Towns ───────────────────────────────────────────────────────────────

  createTown: adminProcedure
    .input(
      z.object({
        name: z.string().min(1).max(64),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const town = await withGastownError(() => gastown.createTown(ctx.user.id, input.name));

      // Store the user's API token on the town config so the mayor can
      // authenticate with the Kilo gateway without needing a rig.
      const kilocodeToken = generateApiToken(ctx.user, undefined, {
        expiresIn: TOKEN_EXPIRY.thirtyDays,
      });
      await withGastownError(() =>
        gastown.updateTownConfig(town.id, {
          kilocode_token: kilocodeToken,
          owner_user_id: ctx.user.id,
        })
      );

      return town;
    }),

  listTowns: adminProcedure.query(async ({ ctx }) => {
    return withGastownError(() => gastown.listTowns(ctx.user.id));
  }),

  getTown: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }
      return town;
    }),

  // ── Rigs ────────────────────────────────────────────────────────────────

  createRig: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        name: z.string().min(1).max(64),
        gitUrl: z.string().url(),
        defaultBranch: z.string().default('main'),
        platformIntegrationId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Verify ownership
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }

      // Auto-detect the platform integration from the git URL when not
      // explicitly provided. This is the server-side safety net that ensures
      // agents always get git credentials even if the frontend omits the ID.
      const platformIntegrationId =
        input.platformIntegrationId ??
        (await resolveIntegrationIdFromGitUrl(ctx.user.id, input.gitUrl));

      if (!input.platformIntegrationId && platformIntegrationId) {
        console.log(
          `${LOG_PREFIX} createRig: auto-resolved platformIntegrationId=${platformIntegrationId} from gitUrl=${input.gitUrl}`
        );
      }

      // Generate a user API token so agents can route LLM calls through the
      // Kilo gateway. Stored in RigConfig and injected into agent env vars.
      // 30-day expiry to limit blast radius if leaked; refreshed on rig update.
      const kilocodeToken = generateApiToken(ctx.user, undefined, {
        expiresIn: TOKEN_EXPIRY.thirtyDays,
      });
      console.log(
        `[gastown-router] createRig: generating kilocodeToken for user=${ctx.user.id} tokenLength=${kilocodeToken?.length ?? 0}`
      );

      const rig = await withGastownError(() =>
        gastown.createRig(ctx.user.id, {
          town_id: input.townId,
          name: input.name,
          git_url: input.gitUrl,
          default_branch: input.defaultBranch,
          kilocode_token: kilocodeToken,
          platform_integration_id: platformIntegrationId,
        })
      );

      // Resolve git credentials from the platform integration and store
      // them in the town config so agents can clone and push.
      // This is a best-effort write: if it fails, the rig exists without
      // git credentials. The container-side resolveGitCredentialsIfMissing
      // and the refreshTownGitCredentials helper serve as recovery mechanisms.
      if (platformIntegrationId) {
        try {
          const gitCredentials = await resolveGitCredentialsFromIntegration(platformIntegrationId);
          if (gitCredentials) {
            console.log(
              `${LOG_PREFIX} createRig: resolved git credentials for integration=${platformIntegrationId} hasGithub=${!!gitCredentials.github_token} hasGitlab=${!!gitCredentials.gitlab_token}`
            );
            await withGastownError(() =>
              gastown.updateTownConfig(input.townId, {
                git_auth: {
                  ...gitCredentials,
                  // Store the integration ID so we can refresh tokens later
                  platform_integration_id: platformIntegrationId,
                },
              })
            );
          } else {
            console.warn(
              `${LOG_PREFIX} createRig: could not resolve git credentials for integration=${platformIntegrationId}`
            );
          }
        } catch (credErr) {
          // Rig was created successfully but git credentials could not be
          // written. Log the error clearly — agents can still resolve
          // credentials on-demand via the container's credential API, and
          // refreshTownGitCredentials can retry later.
          console.error(
            `${LOG_PREFIX} createRig: rig=${rig.id} created but git credential write FAILED for integration=${platformIntegrationId}:`,
            credErr
          );
        }
      }

      return rig;
    }),

  listRigs: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Verify ownership
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }
      return withGastownError(() => gastown.listRigs(ctx.user.id, input.townId));
    }),

  getRig: adminProcedure
    .input(z.object({ rigId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rig = await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      const [agents, beads] = await Promise.all([
        withGastownError(() => gastown.listAgents(rig.town_id, rig.id)),
        withGastownError(() => gastown.listBeads(rig.town_id, rig.id, { status: 'in_progress' })),
      ]);
      return { ...rig, agents, beads };
    }),

  // ── Beads ───────────────────────────────────────────────────────────────

  listBeads: adminProcedure
    .input(
      z.object({
        rigId: z.string().uuid(),
        status: z.enum(['open', 'in_progress', 'closed', 'failed']).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Verify the user owns the rig (getRig will 404 if wrong user)
      const rig = await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      return withGastownError(() =>
        gastown.listBeads(rig.town_id, rig.id, { status: input.status })
      );
    }),

  // ── Agents ──────────────────────────────────────────────────────────────

  listAgents: adminProcedure
    .input(z.object({ rigId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rig = await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      return withGastownError(() => gastown.listAgents(rig.town_id, rig.id));
    }),

  // ── Work Assignment ─────────────────────────────────────────────────────

  sling: adminProcedure
    .input(
      z.object({
        rigId: z.string().uuid(),
        title: z.string().min(1),
        body: z.string().optional(),
        model: z.string().default('kilo/auto'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      console.log(
        `${LOG_PREFIX} sling: rigId=${input.rigId} title="${input.title}" model=${input.model} userId=${ctx.user.id}`
      );
      // Verify ownership
      const rig = await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      console.log(`${LOG_PREFIX} sling: rig verified, name=${rig.name}`);

      // Refresh git credentials before dispatch.
      await refreshTownGitCredentials(rig.town_id, ctx.user.id);

      // Atomic sling: creates bead, assigns/creates polecat, hooks them,
      // and arms the alarm — all in a single Rig DO call to avoid TOCTOU races.
      const result = await withGastownError(() =>
        gastown.slingBead(rig.town_id, rig.id, {
          title: input.title,
          body: input.body,
          metadata: { model: input.model, slung_by: ctx.user.id },
        })
      );
      console.log(
        `${LOG_PREFIX} sling: completed beadId=${result.bead.bead_id} agentId=${result.agent.id} agentRole=${result.agent.role} agentStatus=${result.agent.status}`
      );
      return result;
    }),

  // ── Mayor Communication ─────────────────────────────────────────────────
  // Routes messages to MayorDO (town-level persistent conversational agent).
  // No beads are created — the mayor decides when to delegate work via tools.

  sendMessage: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        message: z.string().min(1),
        model: z.string().default('anthropic/claude-sonnet-4.6'),
        // rigId kept for backward compat but no longer used for routing
        rigId: z.string().uuid().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      console.log(
        `${LOG_PREFIX} sendMessage: townId=${input.townId} message="${input.message.slice(0, 80)}" model=${input.model} userId=${ctx.user.id}`
      );

      // Verify ownership
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      console.log(
        `${LOG_PREFIX} sendMessage: town verified, name=${town.name} owner=${town.owner_user_id}`
      );
      if (town.owner_user_id !== ctx.user.id) {
        console.error(`${LOG_PREFIX} sendMessage: FORBIDDEN - town owner mismatch`);
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }

      // Refresh git credentials before mayor interaction.
      await refreshTownGitCredentials(input.townId, ctx.user.id);

      // Send message directly to MayorDO — single DO call, no beads
      console.log(`${LOG_PREFIX} sendMessage: routing to MayorDO for townId=${input.townId}`);
      const result = await withGastownError(() =>
        gastown.sendMayorMessage(input.townId, input.message, input.model)
      );
      console.log(
        `${LOG_PREFIX} sendMessage: MayorDO responded agentId=${result.agentId} sessionStatus=${result.sessionStatus}`
      );

      return result;
    }),

  // ── Mayor Status ──────────────────────────────────────────────────────

  getMayorStatus: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Verify ownership
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }
      return withGastownError(() => gastown.getMayorStatus(input.townId));
    }),

  ensureMayor: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }

      // Best-effort refresh so polecats dispatched by the mayor's gt_sling
      // tool have a fresh token. Failures must not block the mayor startup.
      try {
        await refreshTownGitCredentials(input.townId, ctx.user.id);
      } catch (err) {
        console.warn(
          `${LOG_PREFIX} ensureMayor: git credential refresh failed (non-blocking)`,
          err
        );
      }

      return withGastownError(() => gastown.ensureMayor(input.townId));
    }),

  // ── Agent Streams ───────────────────────────────────────────────────────

  getAgentStreamUrl: adminProcedure
    .input(
      z.object({
        agentId: z.string().uuid(),
        townId: z.string().uuid(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Verify ownership
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }

      const ticket = await withGastownError(() =>
        gastown.getStreamTicket(input.townId, input.agentId)
      );

      // The gastown worker returns a relative path. Construct the full
      // WebSocket URL using GASTOWN_SERVICE_URL so the browser connects
      // directly to the gastown worker (not the Next.js server).
      const baseUrl = new URL(GASTOWN_SERVICE_URL ?? 'http://localhost:8787');
      const wsProtocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const fullUrl = `${wsProtocol}//${baseUrl.host}${ticket.url}`;

      return { ...ticket, url: fullUrl };
    }),

  // ── Agent Terminal (PTY) ──────────────────────────────────────────────────

  createPtySession: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        agentId: z.string().uuid(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Verify ownership
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }

      // Create a PTY session on the container via the worker
      const pty = await withGastownError(() =>
        gastown.createPtySession(input.townId, input.agentId)
      );

      // Construct the WebSocket URL for the PTY connection
      const baseUrl = new URL(GASTOWN_SERVICE_URL ?? 'http://localhost:8787');
      const wsProtocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${wsProtocol}//${baseUrl.host}/api/towns/${input.townId}/container/agents/${input.agentId}/pty/${pty.id}/connect`;

      return { pty, wsUrl };
    }),

  resizePtySession: adminProcedure
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
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }
      await withGastownError(() =>
        gastown.resizePtySession(input.townId, input.agentId, input.ptyId, input.cols, input.rows)
      );
    }),

  // ── Town Configuration ──────────────────────────────────────────────────

  getTownConfig: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }
      return withGastownError(() => gastown.getTownConfig(input.townId));
    }),

  updateTownConfig: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        config: gastown.TownConfigSchema.partial(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }
      return withGastownError(() => gastown.updateTownConfig(input.townId, input.config));
    }),

  // ── Events ─────────────────────────────────────────────────────────────

  getBeadEvents: adminProcedure
    .input(
      z.object({
        rigId: z.string().uuid(),
        beadId: z.string().uuid().optional(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .query(async ({ ctx, input }) => {
      const rig = await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      return withGastownError(() =>
        gastown.listBeadEvents(rig.town_id, rig.id, {
          beadId: input.beadId,
          since: input.since,
          limit: input.limit,
        })
      );
    }),

  getTownEvents: adminProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .query(async ({ ctx, input }) => {
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }
      return withGastownError(() =>
        gastown.listTownEvents(ctx.user.id, input.townId, {
          since: input.since,
          limit: input.limit,
        })
      );
    }),

  // ── Deletes ────────────────────────────────────────────────────────────

  deleteTown: adminProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }
      await withGastownError(() => gastown.deleteTown(ctx.user.id, input.townId));
    }),

  deleteRig: adminProcedure
    .input(z.object({ rigId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await withGastownError(() => gastown.deleteRig(ctx.user.id, input.rigId));
    }),

  deleteBead: adminProcedure
    .input(z.object({ rigId: z.string().uuid(), beadId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Verify the caller owns this rig before deleting
      const rig = await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      await withGastownError(() => gastown.deleteBead(rig.town_id, rig.id, input.beadId));
    }),

  deleteAgent: adminProcedure
    .input(z.object({ rigId: z.string().uuid(), agentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Verify the caller owns this rig before deleting
      const rig = await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      await withGastownError(() => gastown.deleteAgent(rig.town_id, rig.id, input.agentId));
    }),
});
