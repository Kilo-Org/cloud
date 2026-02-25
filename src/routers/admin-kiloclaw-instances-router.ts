import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import { kiloclaw_instances, kilocode_users } from '@/db/schema';
import { KiloClawInternalClient } from '@/lib/kiloclaw/kiloclaw-internal-client';
import {
  markActiveInstanceDestroyed,
  restoreDestroyedInstance,
} from '@/lib/kiloclaw/instance-registry';
import type { PlatformStatusResponse, VolumeSnapshot } from '@/lib/kiloclaw/types';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import { eq, and, or, desc, asc, ilike, isNull, isNotNull, sql, gte, type SQL } from 'drizzle-orm';

const ListInstancesSchema = z.object({
  offset: z.number().min(0).default(0),
  limit: z.number().min(1).max(100).default(25),
  sortBy: z.enum(['created_at', 'destroyed_at']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
  status: z.enum(['all', 'active', 'destroyed']).default('all'),
});

const GetInstanceSchema = z.object({
  id: z.string().uuid(),
});

const DestroyInstanceSchema = z.object({
  id: z.string().uuid(),
});

const VolumeSnapshotsSchema = z.object({
  userId: z.string().min(1),
});

const GatewayProcessSchema = z.object({
  userId: z.string().min(1),
});

const StatsSchema = z.object({
  days: z.number().min(1).max(365).default(30),
});

export type AdminKiloclawInstance = {
  id: string;
  user_id: string;
  sandbox_id: string;
  created_at: string;
  destroyed_at: string | null;
  user_email: string | null;
};

export type AdminKiloclawInstanceDetail = AdminKiloclawInstance & {
  workerStatus: PlatformStatusResponse | null;
  workerStatusError: string | null;
};

export const adminKiloclawInstancesRouter = createTRPCRouter({
  get: adminProcedure.input(GetInstanceSchema).query(async ({ input }) => {
    const [result] = await db
      .select({
        instance: kiloclaw_instances,
        user_email: kilocode_users.google_user_email,
      })
      .from(kiloclaw_instances)
      .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
      .where(eq(kiloclaw_instances.id, input.id))
      .limit(1);

    if (!result) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Instance not found' });
    }

    const instance: AdminKiloclawInstance = {
      id: result.instance.id,
      user_id: result.instance.user_id,
      sandbox_id: result.instance.sandbox_id,
      created_at: result.instance.created_at,
      destroyed_at: result.instance.destroyed_at,
      user_email: result.user_email,
    };

    // Fetch live worker status for active instances
    let workerStatus: PlatformStatusResponse | null = null;
    let workerStatusError: string | null = null;

    if (instance.destroyed_at === null) {
      try {
        const client = new KiloClawInternalClient();
        workerStatus = await client.getStatus(instance.user_id);
      } catch (err) {
        workerStatusError = err instanceof Error ? err.message : 'Failed to fetch worker status';
      }
    }

    return { ...instance, workerStatus, workerStatusError } satisfies AdminKiloclawInstanceDetail;
  }),

  list: adminProcedure.input(ListInstancesSchema).query(async ({ input }) => {
    const { offset, limit, sortBy, sortOrder, search, status } = input;
    const searchTerm = search?.trim() || '';

    const conditions: SQL[] = [];

    if (searchTerm) {
      const escapedTerm = searchTerm.replace(/[%_\\]/g, '\\$&');
      const ilikePattern = `%${escapedTerm}%`;
      const searchConditions: SQL[] = [
        ilike(kiloclaw_instances.sandbox_id, ilikePattern),
        ilike(kilocode_users.google_user_email, ilikePattern),
      ];

      const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      if (uuidRegex.test(searchTerm)) {
        searchConditions.push(eq(kiloclaw_instances.id, searchTerm));
        searchConditions.push(eq(kiloclaw_instances.user_id, searchTerm));
      }

      const searchCondition = or(...searchConditions);
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    if (status === 'active') {
      conditions.push(isNull(kiloclaw_instances.destroyed_at));
    } else if (status === 'destroyed') {
      conditions.push(isNotNull(kiloclaw_instances.destroyed_at));
    }

    const whereCondition = conditions.length > 0 ? and(...conditions) : undefined;

    const orderFunction = sortOrder === 'asc' ? asc : desc;
    const orderCondition = orderFunction(kiloclaw_instances[sortBy]);

    const instancesResult = await db
      .select({
        instance: kiloclaw_instances,
        user_email: kilocode_users.google_user_email,
      })
      .from(kiloclaw_instances)
      .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
      .where(whereCondition)
      .orderBy(orderCondition)
      .limit(limit)
      .offset(offset);

    const totalCountResult = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(kiloclaw_instances)
      .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
      .where(whereCondition);

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);

    const instances: AdminKiloclawInstance[] = instancesResult.map(row => ({
      id: row.instance.id,
      user_id: row.instance.user_id,
      sandbox_id: row.instance.sandbox_id,
      created_at: row.instance.created_at,
      destroyed_at: row.instance.destroyed_at,
      user_email: row.user_email,
    }));

    return {
      instances,
      pagination: {
        offset,
        limit,
        total: totalCount,
        totalPages,
      },
    };
  }),

  stats: adminProcedure.input(StatsSchema).query(async ({ input }) => {
    const { days } = input;

    // Overview counts
    const [overview] = await db
      .select({
        total_instances: sql<number>`COUNT(*)::int`,
        active_instances: sql<number>`COUNT(CASE WHEN ${kiloclaw_instances.destroyed_at} IS NULL THEN 1 END)::int`,
        destroyed_instances: sql<number>`COUNT(CASE WHEN ${kiloclaw_instances.destroyed_at} IS NOT NULL THEN 1 END)::int`,
        unique_users: sql<number>`COUNT(DISTINCT ${kiloclaw_instances.user_id})::int`,
      })
      .from(kiloclaw_instances);

    // Time-windowed counts
    const [last24h] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(kiloclaw_instances)
      .where(sql`${kiloclaw_instances.created_at} >= NOW() - INTERVAL '24 hours'`);

    const [last7d] = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(kiloclaw_instances)
      .where(sql`${kiloclaw_instances.created_at} >= NOW() - INTERVAL '7 days'`);

    const [activeUsers7d] = await db
      .select({
        count: sql<number>`COUNT(DISTINCT ${kiloclaw_instances.user_id})::int`,
      })
      .from(kiloclaw_instances)
      .where(
        and(
          isNull(kiloclaw_instances.destroyed_at),
          gte(kiloclaw_instances.created_at, sql`NOW() - INTERVAL '7 days'`)
        )
      );

    // Average lifespan of destroyed instances
    const [lifespan] = await db
      .select({
        avg_lifespan_minutes: sql<
          number | null
        >`AVG(EXTRACT(EPOCH FROM (${kiloclaw_instances.destroyed_at}::timestamp - ${kiloclaw_instances.created_at}::timestamp)) / 60)`,
      })
      .from(kiloclaw_instances)
      .where(isNotNull(kiloclaw_instances.destroyed_at));

    // Daily stats for chart
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const dailyStats = await db
      .select({
        date: sql<string>`DATE(${kiloclaw_instances.created_at})`.as('date'),
        created: sql<number>`COUNT(*)::int`.as('created'),
      })
      .from(kiloclaw_instances)
      .where(gte(kiloclaw_instances.created_at, startDate.toISOString()))
      .groupBy(sql`DATE(${kiloclaw_instances.created_at})`)
      .orderBy(sql`DATE(${kiloclaw_instances.created_at})`);

    const dailyDestroyed = await db
      .select({
        date: sql<string>`DATE(${kiloclaw_instances.destroyed_at})`.as('date'),
        destroyed: sql<number>`COUNT(*)::int`.as('destroyed'),
      })
      .from(kiloclaw_instances)
      .where(
        and(
          isNotNull(kiloclaw_instances.destroyed_at),
          gte(kiloclaw_instances.destroyed_at, startDate.toISOString())
        )
      )
      .groupBy(sql`DATE(${kiloclaw_instances.destroyed_at})`)
      .orderBy(sql`DATE(${kiloclaw_instances.destroyed_at})`);

    // Merge created and destroyed into a single daily series
    const destroyedByDate = new Map(dailyDestroyed.map(d => [d.date, d.destroyed]));
    const createdByDate = new Map(dailyStats.map(d => [d.date, d.created]));

    const allDates = new Set([...createdByDate.keys(), ...destroyedByDate.keys()]);
    const dailyChart = [...allDates].sort().map(date => ({
      date,
      created: createdByDate.get(date) ?? 0,
      destroyed: destroyedByDate.get(date) ?? 0,
    }));

    return {
      overview: {
        totalInstances: overview?.total_instances ?? 0,
        activeInstances: overview?.active_instances ?? 0,
        destroyedInstances: overview?.destroyed_instances ?? 0,
        uniqueUsers: overview?.unique_users ?? 0,
        last24hCreated: last24h?.count ?? 0,
        last7dCreated: last7d?.count ?? 0,
        activeUsers7d: activeUsers7d?.count ?? 0,
        avgLifespanMinutes: lifespan?.avg_lifespan_minutes ?? null,
      },
      dailyChart,
    };
  }),

  volumeSnapshots: adminProcedure
    .input(VolumeSnapshotsSchema)
    .query(async ({ input }): Promise<{ snapshots: VolumeSnapshot[] }> => {
      try {
        const client = new KiloClawInternalClient();
        return await client.listVolumeSnapshots(input.userId);
      } catch (err) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: err instanceof Error ? err.message : 'Failed to fetch volume snapshots',
        });
      }
    }),

  gatewayStatus: adminProcedure.input(GatewayProcessSchema).query(async ({ input }) => {
    try {
      const client = new KiloClawInternalClient();
      return await client.getGatewayStatus(input.userId);
    } catch (err) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: err instanceof Error ? err.message : 'Failed to fetch gateway status',
      });
    }
  }),

  gatewayStart: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    try {
      const client = new KiloClawInternalClient();
      return await client.startGateway(input.userId);
    } catch (err) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: err instanceof Error ? err.message : 'Failed to start gateway',
      });
    }
  }),

  gatewayStop: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    try {
      const client = new KiloClawInternalClient();
      return await client.stopGateway(input.userId);
    } catch (err) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: err instanceof Error ? err.message : 'Failed to stop gateway',
      });
    }
  }),

  gatewayRestart: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    try {
      const client = new KiloClawInternalClient();
      return await client.restartGatewayProcess(input.userId);
    } catch (err) {
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: err instanceof Error ? err.message : 'Failed to restart gateway',
      });
    }
  }),

  destroy: adminProcedure.input(DestroyInstanceSchema).mutation(async ({ input, ctx }) => {
    const [instance] = await db
      .select({
        id: kiloclaw_instances.id,
        user_id: kiloclaw_instances.user_id,
        destroyed_at: kiloclaw_instances.destroyed_at,
      })
      .from(kiloclaw_instances)
      .where(eq(kiloclaw_instances.id, input.id))
      .limit(1);

    if (!instance) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Instance not found' });
    }

    if (instance.destroyed_at !== null) {
      throw new TRPCError({ code: 'BAD_REQUEST', message: 'Instance is already destroyed' });
    }

    console.log(
      `[admin-kiloclaw] Destroy triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) for instance ${instance.id} (user: ${instance.user_id})`
    );

    const destroyedRow = await markActiveInstanceDestroyed(instance.user_id);
    const client = new KiloClawInternalClient();
    try {
      await client.destroy(instance.user_id);
    } catch (error) {
      if (destroyedRow) {
        await restoreDestroyedInstance(destroyedRow.id);
      }
      throw error;
    }

    return { success: true };
  }),
});
