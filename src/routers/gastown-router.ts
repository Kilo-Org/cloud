import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import * as gastown from '@/lib/gastown/gastown-client';
import { GastownApiError } from '@/lib/gastown/gastown-client';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { GASTOWN_SERVICE_URL } from '@/lib/config.server';

const LOG_PREFIX = '[gastown-router]';

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

  createTown: baseProcedure
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
        gastown.updateTownConfig(town.id, { kilocode_token: kilocodeToken })
      );

      return town;
    }),

  listTowns: baseProcedure.query(async ({ ctx }) => {
    return withGastownError(() => gastown.listTowns(ctx.user.id));
  }),

  getTown: baseProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }
      return town;
    }),

  // ── Rigs ────────────────────────────────────────────────────────────────

  createRig: baseProcedure
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

      // Generate a user API token so agents can route LLM calls through the
      // Kilo gateway. Stored in RigConfig and injected into agent env vars.
      // 30-day expiry to limit blast radius if leaked; refreshed on rig update.
      const kilocodeToken = generateApiToken(ctx.user, undefined, {
        expiresIn: TOKEN_EXPIRY.thirtyDays,
      });
      console.log(
        `[gastown-router] createRig: generating kilocodeToken for user=${ctx.user.id} tokenLength=${kilocodeToken?.length ?? 0}`
      );

      return withGastownError(() =>
        gastown.createRig(ctx.user.id, {
          town_id: input.townId,
          name: input.name,
          git_url: input.gitUrl,
          default_branch: input.defaultBranch,
          kilocode_token: kilocodeToken,
          platform_integration_id: input.platformIntegrationId,
        })
      );
    }),

  listRigs: baseProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Verify ownership
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }
      return withGastownError(() => gastown.listRigs(ctx.user.id, input.townId));
    }),

  getRig: baseProcedure
    .input(z.object({ rigId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const rig = await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      const [agents, beads] = await Promise.all([
        withGastownError(() => gastown.listAgents(rig.id)),
        withGastownError(() => gastown.listBeads(rig.id, { status: 'in_progress' })),
      ]);
      return { ...rig, agents, beads };
    }),

  // ── Beads ───────────────────────────────────────────────────────────────

  listBeads: baseProcedure
    .input(
      z.object({
        rigId: z.string().uuid(),
        status: z.enum(['open', 'in_progress', 'closed', 'failed']).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      // Verify the user owns the rig (getRig will 404 if wrong user)
      await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      return withGastownError(() => gastown.listBeads(input.rigId, { status: input.status }));
    }),

  // ── Agents ──────────────────────────────────────────────────────────────

  listAgents: baseProcedure
    .input(z.object({ rigId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      return withGastownError(() => gastown.listAgents(input.rigId));
    }),

  // ── Work Assignment ─────────────────────────────────────────────────────

  sling: baseProcedure
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

      // Atomic sling: creates bead, assigns/creates polecat, hooks them,
      // and arms the alarm — all in a single Rig DO call to avoid TOCTOU races.
      const result = await withGastownError(() =>
        gastown.slingBead(rig.id, {
          title: input.title,
          body: input.body,
          metadata: { model: input.model, slung_by: ctx.user.id },
        })
      );
      console.log(
        `${LOG_PREFIX} sling: completed beadId=${result.bead.id} agentId=${result.agent.id} agentRole=${result.agent.role} agentStatus=${result.agent.status}`
      );
      return result;
    }),

  // ── Mayor Communication ─────────────────────────────────────────────────
  // Routes messages to MayorDO (town-level persistent conversational agent).
  // No beads are created — the mayor decides when to delegate work via tools.

  sendMessage: baseProcedure
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

  getMayorStatus: baseProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      // Verify ownership
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }
      return withGastownError(() => gastown.getMayorStatus(input.townId));
    }),

  // ── Agent Streams ───────────────────────────────────────────────────────

  getAgentStreamUrl: baseProcedure
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

  // ── Town Configuration ──────────────────────────────────────────────────

  getTownConfig: baseProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }
      return withGastownError(() => gastown.getTownConfig(input.townId));
    }),

  updateTownConfig: baseProcedure
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

  getBeadEvents: baseProcedure
    .input(
      z.object({
        rigId: z.string().uuid(),
        beadId: z.string().uuid().optional(),
        since: z.string().optional(),
        limit: z.number().int().positive().max(500).default(100),
      })
    )
    .query(async ({ ctx, input }) => {
      await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      return withGastownError(() =>
        gastown.listBeadEvents(input.rigId, {
          beadId: input.beadId,
          since: input.since,
          limit: input.limit,
        })
      );
    }),

  getTownEvents: baseProcedure
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

  deleteTown: baseProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }
      await withGastownError(() => gastown.deleteTown(ctx.user.id, input.townId));
    }),

  deleteRig: baseProcedure
    .input(z.object({ rigId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await withGastownError(() => gastown.deleteRig(ctx.user.id, input.rigId));
    }),

  deleteBead: baseProcedure
    .input(z.object({ rigId: z.string().uuid(), beadId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Verify the caller owns this rig before deleting
      await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      await withGastownError(() => gastown.deleteBead(input.rigId, input.beadId));
    }),

  deleteAgent: baseProcedure
    .input(z.object({ rigId: z.string().uuid(), agentId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      // Verify the caller owns this rig before deleting
      await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      await withGastownError(() => gastown.deleteAgent(input.rigId, input.agentId));
    }),
});
