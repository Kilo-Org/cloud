import 'server-only';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import * as gastown from '@/lib/gastown/gastown-client';
import { GastownApiError } from '@/lib/gastown/gastown-client';

/**
 * Wraps a gastown client call and converts GastownApiError into TRPCError
 * with an appropriate code.
 */
async function withGastownError<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GastownApiError) {
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

      return withGastownError(() =>
        gastown.createRig(ctx.user.id, {
          town_id: input.townId,
          name: input.name,
          git_url: input.gitUrl,
          default_branch: input.defaultBranch,
        })
      );
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
        status: z.enum(['open', 'in_progress', 'closed']).optional(),
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
      // Verify ownership
      const rig = await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));

      // Atomic sling: creates bead, assigns/creates polecat, hooks them,
      // and arms the alarm — all in a single Rig DO call to avoid TOCTOU races.
      return withGastownError(() =>
        gastown.slingBead(rig.id, {
          title: input.title,
          body: input.body,
          metadata: { model: input.model, slung_by: ctx.user.id },
        })
      );
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
      // Verify ownership
      const town = await withGastownError(() => gastown.getTown(ctx.user.id, input.townId));
      if (town.owner_user_id !== ctx.user.id) {
        throw new TRPCError({ code: 'FORBIDDEN', message: 'Not your town' });
      }

      // Verify rig belongs to this town
      const rig = await withGastownError(() => gastown.getRig(ctx.user.id, input.rigId));
      if (rig.town_id !== input.townId) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: 'Rig does not belong to this town' });
      }

      // Atomically get or create the Mayor agent in the Rig DO to avoid
      // duplicate mayor creation from concurrent calls.
      const mayor = await withGastownError(() => gastown.getOrCreateAgent(input.rigId, 'mayor'));

      const bead = await withGastownError(() =>
        gastown.createBead(input.rigId, {
          type: 'message',
          title: input.message,
          assignee_agent_id: mayor.id,
          metadata: { model: input.model, sent_by: ctx.user.id },
        })
      );

      // Hook bead to mayor → arms alarm → alarm dispatches to container
      await withGastownError(() => gastown.hookBead(input.rigId, mayor.id, bead.id));

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
});
