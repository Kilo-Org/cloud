import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import * as gastown from '@/lib/gastown/gastown-client';
import { GastownApiError } from '@/lib/gastown/gastown-client';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';

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
      return withGastownError(() => gastown.createTown(ctx.user.id, input.name));
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

      return withGastownError(() =>
        gastown.createRig(ctx.user.id, {
          town_id: input.townId,
          name: input.name,
          git_url: input.gitUrl,
          default_branch: input.defaultBranch,
          kilocode_token: kilocodeToken,
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

  sendMessage: baseProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        rigId: z.string().uuid(),
        message: z.string().min(1),
        model: z.string().default('kilo/auto'),
      })
    )
    .mutation(async ({ ctx, input }) => {
      console.log(
        `${LOG_PREFIX} sendMessage: townId=${input.townId} rigId=${input.rigId} message="${input.message.slice(0, 80)}" model=${input.model} userId=${ctx.user.id}`
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

      // Verify rig belongs to this town
      const rig = await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      console.log(
        `${LOG_PREFIX} sendMessage: rig verified, name=${rig.name} town_id=${rig.town_id}`
      );
      if (rig.town_id !== input.townId) {
        console.error(
          `${LOG_PREFIX} sendMessage: BAD_REQUEST - rig.town_id=${rig.town_id} !== input.townId=${input.townId}`
        );
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Rig does not belong to this town' });
      }

      // Atomically get or create the Mayor agent in the Rig DO to avoid
      // duplicate mayor creation from concurrent calls.
      console.log(
        `${LOG_PREFIX} sendMessage: calling getOrCreateAgent(rigId=${input.rigId}, role=mayor)`
      );
      const mayor = await withGastownError(() => gastown.getOrCreateAgent(input.rigId, 'mayor'));
      console.log(
        `${LOG_PREFIX} sendMessage: mayor agent id=${mayor.id} name=${mayor.name} status=${mayor.status} current_hook_bead_id=${mayor.current_hook_bead_id}`
      );

      console.log(`${LOG_PREFIX} sendMessage: creating message bead assigned to mayor ${mayor.id}`);
      const bead = await withGastownError(() =>
        gastown.createBead(input.rigId, {
          type: 'message',
          title: input.message,
          assignee_agent_id: mayor.id,
          metadata: { model: input.model, sent_by: ctx.user.id },
        })
      );
      console.log(
        `${LOG_PREFIX} sendMessage: bead created id=${bead.id} type=${bead.type} status=${bead.status}`
      );

      // Hook bead to mayor → arms alarm → alarm dispatches to container
      console.log(`${LOG_PREFIX} sendMessage: hooking bead ${bead.id} to mayor ${mayor.id}`);
      await withGastownError(() => gastown.hookBead(input.rigId, mayor.id, bead.id));
      console.log(`${LOG_PREFIX} sendMessage: hook completed successfully`);

      return { bead, agent: mayor };
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

      return withGastownError(() => gastown.getStreamTicket(input.townId, input.agentId));
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
