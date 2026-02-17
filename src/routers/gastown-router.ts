import 'server-only';

import * as z from 'zod';
import { TRPCError } from '@trpc/server';
import { and, eq, isNull } from 'drizzle-orm';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { gastown_towns, gastown_rigs } from '@/db/schema';
import { gastownSandboxId } from '@/lib/gastown/sandbox-id';
import {
  GASTOWN_FLY_API_TOKEN,
  GASTOWN_FLY_APP_NAME,
  GASTOWN_FLY_REGION,
  GASTOWN_SANDBOX_IMAGE,
  GASTOWN_INTERNAL_API_SECRET,
} from '@/lib/config.server';
import {
  createVolume,
  createMachine,
  startMachine,
  stopMachine,
  destroyMachine,
  deleteVolume,
  isFlyNotFound,
} from '@/lib/gastown/fly-client';
import type { GastownFlyConfig } from '@/lib/gastown/fly-client';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';

function getFlyConfig(): GastownFlyConfig {
  if (!GASTOWN_FLY_API_TOKEN) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Gastown Fly API not configured',
    });
  }
  if (!GASTOWN_FLY_APP_NAME) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Gastown Fly app not configured',
    });
  }
  if (!GASTOWN_SANDBOX_IMAGE) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Gastown sandbox image not configured',
    });
  }
  return { apiToken: GASTOWN_FLY_API_TOKEN, appName: GASTOWN_FLY_APP_NAME };
}

const GASTOWN_VOLUME_SIZE_GB = 50;
const GASTOWN_VOLUME_MOUNT_PATH = '/data';

export const gastownRouter = createTRPCRouter({
  createTown: baseProcedure
    .input(z.object({ townName: z.string().min(1).max(100) }))
    .mutation(async ({ ctx, input }) => {
      const flyConfig = getFlyConfig();
      const sandboxId = gastownSandboxId(ctx.user.id, input.townName);
      const region = GASTOWN_FLY_REGION;

      // Insert DB row with status=provisioning
      const [town] = await db
        .insert(gastown_towns)
        .values({
          user_id: ctx.user.id,
          town_name: input.townName,
          sandbox_id: sandboxId,
          fly_region: region,
          status: 'provisioning',
        })
        .returning();

      if (!town) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to create town row',
        });
      }

      let volumeId: string | undefined;
      try {
        // Mint a gateway JWT for the sandbox (stub — PR 5 will implement full refresh)
        const gatewayJwt = generateApiToken(ctx.user, undefined, {
          expiresIn: TOKEN_EXPIRY.thirtyDays,
        });

        // Create persistent volume
        const volume = await createVolume(flyConfig, {
          name: `gastown-${sandboxId}`,
          region,
          size_gb: GASTOWN_VOLUME_SIZE_GB,
        });
        volumeId = volume.id;

        // Create Fly machine
        const internalApiKey = GASTOWN_INTERNAL_API_SECRET || crypto.randomUUID();
        const machine = await createMachine(
          flyConfig,
          {
            image: GASTOWN_SANDBOX_IMAGE,
            guest: { cpus: 4, memory_mb: 8192, cpu_kind: 'shared' },
            env: {
              KILO_API_URL: process.env.KILO_API_URL ?? 'https://api.kilo.ai',
              KILO_JWT: gatewayJwt,
              TOWN_ID: town.id,
              SANDBOX_ID: sandboxId,
              INTERNAL_API_KEY: internalApiKey,
            },
            mounts: [{ volume: volume.id, path: GASTOWN_VOLUME_MOUNT_PATH }],
            metadata: {
              gastown_town_id: town.id,
              gastown_user_id: ctx.user.id,
            },
          },
          { name: `gastown-${sandboxId}`, region }
        );

        // Update DB row with Fly IDs and mark running
        const [updated] = await db
          .update(gastown_towns)
          .set({
            fly_machine_id: machine.id,
            fly_volume_id: volume.id,
            fly_region: machine.region,
            status: 'running',
          })
          .where(eq(gastown_towns.id, town.id))
          .returning();

        if (!updated) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Failed to update town status',
          });
        }

        return { id: updated.id, status: updated.status };
      } catch (error) {
        // Best-effort cleanup of Fly resources created before failure
        if (volumeId) {
          try {
            await deleteVolume(flyConfig, volumeId);
          } catch {
            // Volume cleanup is best-effort; health monitor will reconcile
          }
        }
        // Soft-delete the DB row
        await db
          .update(gastown_towns)
          .set({ status: 'destroyed', destroyed_at: new Date().toISOString() })
          .where(eq(gastown_towns.id, town.id));
        throw error;
      }
    }),

  destroyTown: baseProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const flyConfig = getFlyConfig();

      const [town] = await db
        .select()
        .from(gastown_towns)
        .where(
          and(
            eq(gastown_towns.id, input.townId),
            eq(gastown_towns.user_id, ctx.user.id),
            isNull(gastown_towns.destroyed_at)
          )
        )
        .limit(1);

      if (!town) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Town not found' });
      }

      // Soft-delete first
      await db
        .update(gastown_towns)
        .set({ status: 'destroyed', destroyed_at: new Date().toISOString() })
        .where(eq(gastown_towns.id, town.id));

      // Destroy Fly resources (best-effort; row is already soft-deleted)
      if (town.fly_machine_id) {
        try {
          await destroyMachine(flyConfig, town.fly_machine_id);
        } catch (err) {
          if (!isFlyNotFound(err)) throw err;
        }
      }
      if (town.fly_volume_id) {
        try {
          await deleteVolume(flyConfig, town.fly_volume_id);
        } catch (err) {
          if (!isFlyNotFound(err)) throw err;
        }
      }

      return { id: town.id, status: 'destroyed' satisfies typeof town.status };
    }),

  getTownStatus: baseProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [town] = await db
        .select({
          id: gastown_towns.id,
          town_name: gastown_towns.town_name,
          status: gastown_towns.status,
          fly_region: gastown_towns.fly_region,
          last_heartbeat_at: gastown_towns.last_heartbeat_at,
          last_r2_sync_at: gastown_towns.last_r2_sync_at,
          config: gastown_towns.config,
          created_at: gastown_towns.created_at,
        })
        .from(gastown_towns)
        .where(
          and(
            eq(gastown_towns.id, input.townId),
            eq(gastown_towns.user_id, ctx.user.id),
            isNull(gastown_towns.destroyed_at)
          )
        )
        .limit(1);

      if (!town) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Town not found' });
      }

      return town;
    }),

  listTowns: baseProcedure.query(async ({ ctx }) => {
    return db
      .select({
        id: gastown_towns.id,
        town_name: gastown_towns.town_name,
        status: gastown_towns.status,
        fly_region: gastown_towns.fly_region,
        last_heartbeat_at: gastown_towns.last_heartbeat_at,
        created_at: gastown_towns.created_at,
      })
      .from(gastown_towns)
      .where(and(eq(gastown_towns.user_id, ctx.user.id), isNull(gastown_towns.destroyed_at)));
  }),

  stopTown: baseProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const flyConfig = getFlyConfig();

      const [town] = await db
        .select()
        .from(gastown_towns)
        .where(
          and(
            eq(gastown_towns.id, input.townId),
            eq(gastown_towns.user_id, ctx.user.id),
            isNull(gastown_towns.destroyed_at)
          )
        )
        .limit(1);

      if (!town) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Town not found' });
      }
      if (town.status !== 'running') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot stop town in status: ${town.status}`,
        });
      }
      if (!town.fly_machine_id) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Town has no Fly machine' });
      }

      await stopMachine(flyConfig, town.fly_machine_id);

      const [updated] = await db
        .update(gastown_towns)
        .set({ status: 'stopped' })
        .where(eq(gastown_towns.id, town.id))
        .returning({ id: gastown_towns.id, status: gastown_towns.status });

      if (!updated) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update town status',
        });
      }
      return updated;
    }),

  startTown: baseProcedure
    .input(z.object({ townId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const flyConfig = getFlyConfig();

      const [town] = await db
        .select()
        .from(gastown_towns)
        .where(
          and(
            eq(gastown_towns.id, input.townId),
            eq(gastown_towns.user_id, ctx.user.id),
            isNull(gastown_towns.destroyed_at)
          )
        )
        .limit(1);

      if (!town) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Town not found' });
      }
      if (town.status !== 'stopped') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Cannot start town in status: ${town.status}`,
        });
      }
      if (!town.fly_machine_id) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Town has no Fly machine' });
      }

      await startMachine(flyConfig, town.fly_machine_id);

      const [updated] = await db
        .update(gastown_towns)
        .set({ status: 'running' })
        .where(eq(gastown_towns.id, town.id))
        .returning({ id: gastown_towns.id, status: gastown_towns.status });

      if (!updated) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to update town status',
        });
      }
      return updated;
    }),

  addRig: baseProcedure
    .input(
      z.object({
        townId: z.string().uuid(),
        rigName: z.string().min(1).max(100),
        repoUrl: z.string().url(),
        branch: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      // Verify town ownership
      const [town] = await db
        .select({ id: gastown_towns.id })
        .from(gastown_towns)
        .where(
          and(
            eq(gastown_towns.id, input.townId),
            eq(gastown_towns.user_id, ctx.user.id),
            isNull(gastown_towns.destroyed_at)
          )
        )
        .limit(1);

      if (!town) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Town not found' });
      }

      const [rig] = await db
        .insert(gastown_rigs)
        .values({
          town_id: input.townId,
          rig_name: input.rigName,
          repo_url: input.repoUrl,
          branch: input.branch ?? 'main',
        })
        .returning();

      return rig;
    }),

  removeRig: baseProcedure
    .input(z.object({ townId: z.string().uuid(), rigName: z.string() }))
    .mutation(async ({ ctx, input }) => {
      // Verify town ownership
      const [town] = await db
        .select({ id: gastown_towns.id })
        .from(gastown_towns)
        .where(
          and(
            eq(gastown_towns.id, input.townId),
            eq(gastown_towns.user_id, ctx.user.id),
            isNull(gastown_towns.destroyed_at)
          )
        )
        .limit(1);

      if (!town) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Town not found' });
      }

      const [removed] = await db
        .update(gastown_rigs)
        .set({ status: 'removed' })
        .where(
          and(
            eq(gastown_rigs.town_id, input.townId),
            eq(gastown_rigs.rig_name, input.rigName),
            eq(gastown_rigs.status, 'active')
          )
        )
        .returning({ id: gastown_rigs.id, rig_name: gastown_rigs.rig_name });

      if (!removed) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Rig not found' });
      }

      return removed;
    }),
});
