import { adminProcedure, createTRPCRouter, UpstreamApiError } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  kiloclaw_instances,
  kiloclaw_subscriptions,
  kiloclaw_email_log,
  kiloclaw_cli_runs,
  kilocode_users,
} from '@kilocode/db/schema';
import type { KiloClawSubscriptionStatus } from '@kilocode/db/schema-types';
import { KiloClawInternalClient, KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { KiloClawUserClient } from '@/lib/kiloclaw/kiloclaw-user-client';
import {
  getActiveInstance,
  getInstanceById,
  markActiveInstanceDestroyed,
  markInstanceDestroyedById,
  restoreDestroyedInstance,
  workerInstanceId,
} from '@/lib/kiloclaw/instance-registry';
import { flyAppNameFromUserId } from '@/lib/kiloclaw/fly-app-name';
import {
  createKiloClawAdminAuditLog,
  listKiloClawAdminAuditLogs,
} from '@/lib/kiloclaw/admin-audit-log';
import type {
  PlatformDebugStatusResponse,
  VolumeSnapshot,
  CandidateVolumesResponse,
  ReassociateVolumeResponse,
  ResizeMachineResponse,
  RestoreVolumeSnapshotResponse,
} from '@/lib/kiloclaw/types';
import { generateApiToken, TOKEN_EXPIRY } from '@/lib/tokens';
import { TRPCError } from '@trpc/server';
import * as z from 'zod';
import {
  eq,
  and,
  or,
  desc,
  asc,
  ilike,
  isNull,
  isNotNull,
  inArray,
  sql,
  gte,
  lte,
  type SQL,
} from 'drizzle-orm';

const ListInstancesSchema = z.object({
  offset: z.number().min(0).default(0),
  limit: z.number().min(1).max(100).default(25),
  sortBy: z.enum(['created_at', 'destroyed_at']).default('created_at'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
  search: z.string().optional(),
  status: z.enum(['all', 'active', 'suspended', 'destroyed']).default('all'),
});

const DetectOrphansSchema = z.object({
  /** ISO date string — only check instances created on or after this date. */
  createdAfter: z.string().datetime(),
  /** ISO date string — only check instances created on or before this date. */
  createdBefore: z.string().datetime(),
});

const GetInstanceSchema = z.object({
  id: z.string().uuid(),
});

const DestroyInstanceSchema = z.object({
  id: z.string().uuid(),
});

const VolumeSnapshotsSchema = z.object({
  userId: z.string().min(1),
  instanceId: z.string().uuid().optional(),
});

const GatewayProcessSchema = z.object({
  userId: z.string().min(1),
  instanceId: z.string().uuid().optional(),
});

const StatsSchema = z.object({
  days: z.number().min(1).max(365).default(30),
});

type KiloclawTrpcCode =
  | 'BAD_REQUEST'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'TOO_MANY_REQUESTS'
  | 'INTERNAL_SERVER_ERROR';

function kiloclawStatusToTrpcCode(statusCode: number): KiloclawTrpcCode {
  switch (statusCode) {
    case 400:
      return 'BAD_REQUEST';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 429:
      return 'TOO_MANY_REQUESTS';
    default:
      return 'INTERNAL_SERVER_ERROR';
  }
}

function getKiloclawApiErrorMessage(err: KiloClawApiError, fallbackMessage: string): string {
  if (!err.responseBody) return fallbackMessage;

  try {
    const parsed: unknown = JSON.parse(err.responseBody);
    if (typeof parsed === 'object' && parsed !== null) {
      const record = parsed as { error?: unknown; message?: unknown };
      if (typeof record.error === 'string') return record.error;
      if (typeof record.message === 'string') return record.message;
    }
  } catch {
    // Fall back to the raw response body when the controller did not return JSON.
  }

  return err.responseBody.trim() || fallbackMessage;
}

function throwKiloclawAdminError(
  err: unknown,
  fallbackMessage: string,
  options?: {
    statusCodeOverrides?: Partial<Record<number, KiloclawTrpcCode>>;
    messageOverrides?: Partial<Record<number, string>>;
  }
): never {
  if (err instanceof KiloClawApiError) {
    throw new TRPCError({
      code:
        options?.statusCodeOverrides?.[err.statusCode] ?? kiloclawStatusToTrpcCode(err.statusCode),
      message:
        options?.messageOverrides?.[err.statusCode] ??
        getKiloclawApiErrorMessage(err, fallbackMessage),
      cause: err,
    });
  }

  throw new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: err instanceof Error ? `${fallbackMessage}: ${err.message}` : fallbackMessage,
    cause: err instanceof Error ? err : undefined,
  });
}

/**
 * Resolve the target instance for admin operations.
 * When instanceId is provided, look it up directly and throw NOT_FOUND if missing.
 * Otherwise fall back to the user's active (personal) instance.
 */
async function resolveInstance(userId: string, instanceId?: string) {
  if (instanceId) {
    const instance = await getInstanceById(instanceId);
    if (!instance) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: `Instance ${instanceId} not found`,
      });
    }
    return instance;
  }
  return getActiveInstance(userId);
}

export type AdminKiloclawInstance = {
  id: string;
  user_id: string;
  sandbox_id: string;
  organization_id: string | null;
  created_at: string;
  destroyed_at: string | null;
  suspended_at: string | null;
  user_email: string | null;
  subscription_id: string | null;
  subscription_status: KiloClawSubscriptionStatus | null;
};

export type AdminKiloclawInstanceDetail = AdminKiloclawInstance & {
  derived_fly_app_name: string;
  workerStatus: PlatformDebugStatusResponse | null;
  workerStatusError: string | null;
};

export const adminKiloclawInstancesRouter = createTRPCRouter({
  get: adminProcedure.input(GetInstanceSchema).query(async ({ input }) => {
    const [result] = await db
      .select({
        instance: kiloclaw_instances,
        user_email: kilocode_users.google_user_email,
        suspended_at: kiloclaw_subscriptions.suspended_at,
        subscription_id: kiloclaw_subscriptions.id,
        subscription_status: kiloclaw_subscriptions.status,
      })
      .from(kiloclaw_instances)
      .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id)
      )
      .where(eq(kiloclaw_instances.id, input.id))
      .limit(1);

    if (!result) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Instance not found' });
    }

    const instance: AdminKiloclawInstance = {
      id: result.instance.id,
      user_id: result.instance.user_id,
      sandbox_id: result.instance.sandbox_id,
      organization_id: result.instance.organization_id,
      created_at: result.instance.created_at,
      destroyed_at: result.instance.destroyed_at,
      suspended_at: result.suspended_at ?? null,
      user_email: result.user_email,
      subscription_id: result.subscription_id ?? null,
      subscription_status: result.subscription_status ?? null,
    };

    const derivedFlyAppName = flyAppNameFromUserId(instance.user_id);

    // Fetch live worker status for all instances.
    // DB may be marked destroyed while DO is still retrying destroy.
    let workerStatus: PlatformDebugStatusResponse | null = null;
    let workerStatusError: string | null = null;

    try {
      const client = new KiloClawInternalClient();
      workerStatus = await client.getDebugStatus(instance.user_id, workerInstanceId(instance));
    } catch (err) {
      workerStatusError =
        err instanceof KiloClawApiError
          ? getKiloclawApiErrorMessage(err, 'Failed to fetch worker status')
          : err instanceof Error
            ? err.message
            : 'Failed to fetch worker status';
    }

    return {
      ...instance,
      derived_fly_app_name: derivedFlyAppName,
      workerStatus,
      workerStatusError,
    } satisfies AdminKiloclawInstanceDetail;
  }),

  registryEntries: adminProcedure
    .input(z.object({ userId: z.string().min(1), orgId: z.string().optional() }))
    .query(async ({ input }) => {
      const client = new KiloClawInternalClient();
      return client.getRegistryEntries(input.userId, input.orgId ?? undefined);
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
      conditions.push(isNull(kiloclaw_subscriptions.suspended_at));
    } else if (status === 'suspended') {
      conditions.push(isNull(kiloclaw_instances.destroyed_at));
      conditions.push(isNotNull(kiloclaw_subscriptions.suspended_at));
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
        suspended_at: kiloclaw_subscriptions.suspended_at,
        subscription_id: kiloclaw_subscriptions.id,
        subscription_status: kiloclaw_subscriptions.status,
      })
      .from(kiloclaw_instances)
      .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id)
      )
      .where(whereCondition)
      .orderBy(orderCondition)
      .limit(limit)
      .offset(offset);

    const totalCountResult = await db
      .select({ count: sql<number>`COUNT(*)::int` })
      .from(kiloclaw_instances)
      .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id)
      )
      .where(whereCondition);

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);

    const instances: AdminKiloclawInstance[] = instancesResult.map(row => ({
      id: row.instance.id,
      user_id: row.instance.user_id,
      sandbox_id: row.instance.sandbox_id,
      organization_id: row.instance.organization_id,
      created_at: row.instance.created_at,
      destroyed_at: row.instance.destroyed_at,
      suspended_at: row.suspended_at ?? null,
      user_email: row.user_email,
      subscription_id: row.subscription_id ?? null,
      subscription_status: row.subscription_status ?? null,
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

    // Overview counts (join subscriptions to derive suspended state)
    const [overview] = await db
      .select({
        total_instances: sql<number>`COUNT(*)::int`,
        active_instances: sql<number>`COUNT(CASE WHEN ${kiloclaw_instances.destroyed_at} IS NULL AND ${kiloclaw_subscriptions.suspended_at} IS NULL THEN 1 END)::int`,
        suspended_instances: sql<number>`COUNT(CASE WHEN ${kiloclaw_instances.destroyed_at} IS NULL AND ${kiloclaw_subscriptions.suspended_at} IS NOT NULL THEN 1 END)::int`,
        destroyed_instances: sql<number>`COUNT(CASE WHEN ${kiloclaw_instances.destroyed_at} IS NOT NULL THEN 1 END)::int`,
        unique_users: sql<number>`COUNT(DISTINCT ${kiloclaw_instances.user_id})::int`,
      })
      .from(kiloclaw_instances)
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id)
      );

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
        suspendedInstances: overview?.suspended_instances ?? 0,
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
      const fallbackMessage = 'Failed to fetch volume snapshots';
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        return await client.listVolumeSnapshots(input.userId, workerInstanceId(instance));
      } catch (err) {
        console.error('Failed to fetch volume snapshots for user:', input.userId, err);
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  controllerVersion: adminProcedure.input(GatewayProcessSchema).query(async ({ input }) => {
    const fallbackMessage = 'Failed to fetch controller version';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.getControllerVersion(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to fetch controller version for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  gatewayStatus: adminProcedure.input(GatewayProcessSchema).query(async ({ input }) => {
    const fallbackMessage = 'Failed to fetch gateway status';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.getGatewayStatus(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to fetch gateway status for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage, {
        statusCodeOverrides: { 409: 'NOT_FOUND' },
        messageOverrides: {
          404: 'Gateway control unavailable',
          409: 'Gateway control unavailable',
        },
      });
    }
  }),

  gatewayStart: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to start gateway';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.startGateway(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to start gateway for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  gatewayStop: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to stop gateway';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.stopGateway(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to stop gateway for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  gatewayRestart: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to restart gateway';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.restartGatewayProcess(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to restart gateway for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  runDoctor: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to run doctor';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.runDoctor(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to run doctor for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  startKiloCliRun: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        prompt: z.string().min(1).max(10_000),
      })
    )
    .mutation(async ({ input }) => {
      const fallbackMessage = 'Failed to start kilo CLI run';
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        return await client.startKiloCliRun(input.userId, input.prompt, workerInstanceId(instance));
      } catch (err) {
        console.error('Failed to start kilo CLI run for user:', input.userId, err);
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  getKiloCliRunStatus: adminProcedure.input(GatewayProcessSchema).query(async ({ input }) => {
    const fallbackMessage = 'Failed to get kilo CLI run status';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.getKiloCliRunStatus(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to get kilo CLI run status for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  listKiloCliRuns: adminProcedure
    .input(z.object({ userId: z.string().min(1), limit: z.number().min(1).max(50).default(20) }))
    .query(async ({ input }) => {
      const runs = await db
        .select()
        .from(kiloclaw_cli_runs)
        .where(eq(kiloclaw_cli_runs.user_id, input.userId))
        .orderBy(desc(kiloclaw_cli_runs.started_at))
        .limit(input.limit);

      return { runs };
    }),

  listAllCliRuns: adminProcedure
    .input(
      z.object({
        offset: z.number().min(0).default(0),
        limit: z.number().min(1).max(100).default(25),
        search: z.string().optional(),
        status: z.enum(['all', 'running', 'completed', 'failed', 'cancelled']).default('all'),
      })
    )
    .query(async ({ input }) => {
      const { offset, limit, search, status } = input;
      const conditions: SQL[] = [];

      if (status !== 'all') {
        conditions.push(eq(kiloclaw_cli_runs.status, status));
      }

      const searchTerm = search?.trim();
      if (searchTerm) {
        const escaped = searchTerm.replace(/[%_\\]/g, '\\$&');
        const pattern = `%${escaped}%`;
        const searchCond = or(
          ilike(kilocode_users.google_user_email, pattern),
          ilike(kiloclaw_cli_runs.prompt, pattern)
        );
        if (searchCond) conditions.push(searchCond);
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [rows, countResult] = await Promise.all([
        db
          .select({
            id: kiloclaw_cli_runs.id,
            user_id: kiloclaw_cli_runs.user_id,
            user_email: kilocode_users.google_user_email,
            prompt: kiloclaw_cli_runs.prompt,
            status: kiloclaw_cli_runs.status,
            exit_code: kiloclaw_cli_runs.exit_code,
            started_at: kiloclaw_cli_runs.started_at,
            completed_at: kiloclaw_cli_runs.completed_at,
          })
          .from(kiloclaw_cli_runs)
          .leftJoin(kilocode_users, eq(kiloclaw_cli_runs.user_id, kilocode_users.id))
          .where(where)
          .orderBy(desc(kiloclaw_cli_runs.started_at))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(kiloclaw_cli_runs)
          .leftJoin(kilocode_users, eq(kiloclaw_cli_runs.user_id, kilocode_users.id))
          .where(where),
      ]);

      const total = countResult[0]?.count ?? 0;

      return {
        runs: rows,
        pagination: { offset, limit, total, totalPages: Math.ceil(total / limit) },
      };
    }),

  getCliRunOutput: adminProcedure
    .input(z.object({ runId: z.string().min(1) }))
    .query(async ({ input }) => {
      const [row] = await db
        .select({ output: kiloclaw_cli_runs.output })
        .from(kiloclaw_cli_runs)
        .where(eq(kiloclaw_cli_runs.id, input.runId))
        .limit(1);

      return { output: row?.output ?? null };
    }),

  restoreConfig: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to restore config';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.restoreConfig(input.userId, undefined, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to restore config for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  fileTree: adminProcedure
    .input(z.object({ userId: z.string().min(1), instanceId: z.string().uuid().optional() }))
    .query(async ({ input }) => {
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        const result = await client.getFileTree(input.userId, workerInstanceId(instance));
        return result.tree;
      } catch (err) {
        throwKiloclawAdminError(err, 'Failed to fetch file tree');
      }
    }),

  readFile: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        path: z.string().min(1),
      })
    )
    .query(async ({ input }) => {
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        return await client.readFile(input.userId, input.path, workerInstanceId(instance));
      } catch (err) {
        throwKiloclawAdminError(err, 'Failed to read file');
      }
    }),

  writeFile: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        path: z.string().min(1),
        content: z.string(),
        etag: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        return await client.writeFile(
          input.userId,
          input.path,
          input.content,
          input.etag,
          workerInstanceId(instance)
        );
      } catch (err) {
        // Propagate file_etag_conflict with UpstreamApiError so the UI can detect it
        if (err instanceof KiloClawApiError && err.statusCode === 409) {
          const parsed = JSON.parse(err.responseBody || '{}') as { code?: string; error?: string };
          if (parsed.code === 'file_etag_conflict') {
            throw new TRPCError({
              code: 'CONFLICT',
              message: parsed.error ?? 'File was modified externally',
              cause: new UpstreamApiError('file_etag_conflict'),
            });
          }
        }
        throwKiloclawAdminError(err, 'Failed to write file');
      }
    }),

  machineStart: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to start machine';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.start(input.userId, workerInstanceId(instance), { skipCooldown: true });
    } catch (err) {
      console.error('Failed to start machine for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  forceRetryRecovery: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to retry recovery';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.forceRetryRecovery(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to retry recovery for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  cleanupRecoveryPreviousVolume: adminProcedure
    .input(GatewayProcessSchema)
    .mutation(async ({ input, ctx }) => {
      const fallbackMessage = 'Failed to clean up retained recovery volume';
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        const result = await client.cleanupRecoveryPreviousVolume(
          input.userId,
          workerInstanceId(instance)
        );

        if (result.deletedVolumeId) {
          try {
            await createKiloClawAdminAuditLog({
              action: 'kiloclaw.recovery.cleanup_retained_volume',
              actor_id: ctx.user.id,
              actor_email: ctx.user.google_user_email,
              actor_name: ctx.user.google_user_name,
              target_user_id: input.userId,
              message: `Retained recovery volume deleted: ${result.deletedVolumeId}`,
              metadata: {
                deletedVolumeId: result.deletedVolumeId,
              },
            });
          } catch (auditErr) {
            console.error('Failed to write audit log for cleanupRecoveryPreviousVolume:', auditErr);
          }
        }

        return result;
      } catch (err) {
        console.error('Failed to clean up retained recovery volume for user:', input.userId, err);
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  machineStop: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to stop machine';
    try {
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      return await client.stop(input.userId, workerInstanceId(instance));
    } catch (err) {
      console.error('Failed to stop machine for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  restartMachine: adminProcedure
    .input(
      z.object({
        instanceId: z.string().uuid(),
        imageTag: z
          .string()
          .max(128, 'Image tag too long')
          .regex(
            /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/,
            'Image tag must be alphanumeric with dots, hyphens, or underscores'
          )
          .optional(),
      })
    )
    .mutation(async ({ input }) => {
      const [row] = await db
        .select({
          user: kilocode_users,
          instance: {
            id: kiloclaw_instances.id,
            sandbox_id: kiloclaw_instances.sandbox_id,
          },
        })
        .from(kiloclaw_instances)
        .innerJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
        .where(eq(kiloclaw_instances.id, input.instanceId))
        .limit(1);

      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Instance not found' });
      }

      const token = generateApiToken(row.user, undefined, { expiresIn: TOKEN_EXPIRY.fiveMinutes });
      const client = new KiloClawUserClient(token);
      const fallbackMessage = 'Failed to restart machine';
      try {
        return await client.restartMachine(
          input.imageTag ? { imageTag: input.imageTag } : undefined,
          { userId: row.user.id, instanceId: workerInstanceId(row.instance) }
        );
      } catch (err) {
        console.error('Failed to restart machine for user:', row.user.id, err);
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  destroyFlyMachine: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        appName: z
          .string()
          .min(1)
          .max(63)
          .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Invalid Fly app name'),
        machineId: z
          .string()
          .min(1)
          .regex(/^[a-z0-9]+$/, 'Invalid Fly machine ID'),
      })
    )
    .mutation(async ({ input, ctx }) => {
      console.log(
        `[admin-kiloclaw] destroyFlyMachine triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) app=${input.appName} machine=${input.machineId}`
      );
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();

      // Verify the appName/machineId match the DO's actual state
      let status: Awaited<ReturnType<KiloClawInternalClient['getDebugStatus']>>;
      try {
        status = await client.getDebugStatus(input.userId, workerInstanceId(instance));
      } catch (err) {
        throwKiloclawAdminError(err, 'Failed to verify machine state before destroy');
      }
      if (status.provider !== 'fly') {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Direct Fly machine destroy is not supported for provider ${status.provider}`,
        });
      }
      if (status.flyAppName !== input.appName || status.flyMachineId !== input.machineId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Fly resource mismatch: expected app=${status.flyAppName} machine=${status.flyMachineId}, got app=${input.appName} machine=${input.machineId}`,
        });
      }

      const fallbackMessage = 'Failed to destroy Fly machine';
      try {
        const result = await client.destroyFlyMachine(
          input.userId,
          input.appName,
          input.machineId,
          workerInstanceId(instance)
        );

        try {
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.machine.destroy_fly',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: input.userId,
            message: `Fly machine force-destroyed: app=${input.appName} machine=${input.machineId}`,
            metadata: {
              appName: input.appName,
              machineId: input.machineId,
            },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for destroyFlyMachine:', auditErr);
        }

        return result;
      } catch (err) {
        console.error(
          `Failed to destroy Fly machine app=${input.appName} machine=${input.machineId}:`,
          err
        );
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  extendVolume: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        appName: z
          .string()
          .min(1)
          .max(63)
          .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, 'Invalid Fly app name'),
        volumeId: z
          .string()
          .min(1)
          .regex(/^vol_[a-zA-Z0-9]+$/, 'Invalid Fly volume ID'),
      })
    )
    .mutation(async ({ input, ctx }) => {
      console.log(
        `[admin-kiloclaw] extendVolume triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) app=${input.appName} volume=${input.volumeId} size=15GB`
      );
      const instance = await resolveInstance(input.userId, input.instanceId);
      const client = new KiloClawInternalClient();
      const instanceId = workerInstanceId(instance);

      let status: Awaited<ReturnType<KiloClawInternalClient['getDebugStatus']>>;
      try {
        status = await client.getDebugStatus(input.userId, instanceId);
      } catch (err) {
        throwKiloclawAdminError(err, 'Failed to verify volume state before extend');
      }
      const unsafeExtendStates: ReadonlyArray<string> = ['recovering', 'restoring', 'destroying'];
      if (status.status && unsafeExtendStates.includes(status.status)) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: `Cannot extend volume while instance is ${status.status}`,
        });
      }
      if (status.flyAppName !== input.appName || status.flyVolumeId !== input.volumeId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Fly resource mismatch: expected app=${status.flyAppName} volume=${status.flyVolumeId}, got app=${input.appName} volume=${input.volumeId}`,
        });
      }

      const fallbackMessage = 'Failed to extend Fly volume';
      try {
        const result = await client.extendVolume(
          input.userId,
          input.appName,
          input.volumeId,
          instanceId
        );

        try {
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.volume.extend',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: input.userId,
            message: `Fly volume extended to 15GB: app=${input.appName} volume=${input.volumeId}`,
            metadata: {
              appName: input.appName,
              volumeId: input.volumeId,
              sizeGb: 15,
            },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for extendVolume:', auditErr);
        }

        return result;
      } catch (err) {
        console.error(
          `Failed to extend Fly volume app=${input.appName} volume=${input.volumeId}:`,
          err
        );
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  destroy: adminProcedure.input(DestroyInstanceSchema).mutation(async ({ input, ctx }) => {
    const [instance] = await db
      .select({
        id: kiloclaw_instances.id,
        user_id: kiloclaw_instances.user_id,
        sandbox_id: kiloclaw_instances.sandbox_id,
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

    const destroyedRow = await markActiveInstanceDestroyed(instance.user_id, instance.id);
    const client = new KiloClawInternalClient();
    try {
      await client.destroy(instance.user_id, workerInstanceId(instance));
    } catch (error) {
      if (destroyedRow) {
        await restoreDestroyedInstance(destroyedRow.id);
      }
      throw error;
    }

    // Post-destroy cleanup: best-effort DB tidying that must not report
    // failure after a successful destroy.
    try {
      await db
        .update(kiloclaw_subscriptions)
        .set({ destruction_deadline: null })
        .where(
          and(
            eq(kiloclaw_subscriptions.user_id, instance.user_id),
            eq(kiloclaw_subscriptions.instance_id, instance.id)
          )
        );

      // Clear lifecycle emails so they can fire again if the user re-provisions.
      const resettableEmailTypes = [
        'claw_suspended_trial',
        'claw_suspended_subscription',
        'claw_suspended_payment',
        'claw_destruction_warning',
        'claw_instance_destroyed',
      ];
      await db
        .delete(kiloclaw_email_log)
        .where(
          and(
            eq(kiloclaw_email_log.user_id, instance.user_id),
            inArray(kiloclaw_email_log.email_type, resettableEmailTypes)
          )
        );
      // Clear per-instance ready emails so a future re-provision triggers the notification.
      await db
        .delete(kiloclaw_email_log)
        .where(
          and(
            eq(kiloclaw_email_log.user_id, instance.user_id),
            sql`${kiloclaw_email_log.email_type} LIKE 'claw_instance_ready:%'`
          )
        );
    } catch (cleanupError) {
      console.error('[admin-kiloclaw] Post-destroy cleanup failed:', cleanupError);
    }

    return { success: true };
  }),

  adminAuditLogs: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        action: z.string().optional(),
        limit: z.number().min(1).max(50).default(10),
      })
    )
    .query(async ({ input }) => {
      return listKiloClawAdminAuditLogs({
        target_user_id: input.userId,
        action: input.action as Parameters<typeof listKiloClawAdminAuditLogs>[0]['action'],
        limit: input.limit,
      });
    }),

  candidateVolumes: adminProcedure
    .input(z.object({ userId: z.string().min(1), instanceId: z.string().uuid().optional() }))
    .query(async ({ input }): Promise<CandidateVolumesResponse> => {
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        return await client.listCandidateVolumes(input.userId, workerInstanceId(instance));
      } catch (err) {
        throwKiloclawAdminError(err, 'Failed to list candidate volumes');
      }
    }),

  devNukeAll: adminProcedure.mutation(async ({ ctx }) => {
    if (process.env.NODE_ENV !== 'development') {
      throw new TRPCError({
        code: 'FORBIDDEN',
        message: 'This endpoint is only available in development mode',
      });
    }

    const activeInstances = await db
      .select({
        id: kiloclaw_instances.id,
        user_id: kiloclaw_instances.user_id,
        sandbox_id: kiloclaw_instances.sandbox_id,
      })
      .from(kiloclaw_instances)
      .where(isNull(kiloclaw_instances.destroyed_at));

    console.log(
      `[admin-kiloclaw] DevNukeAll triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}): ${activeInstances.length} active instances`
    );

    const client = new KiloClawInternalClient();
    let destroyed = 0;
    const errors: Array<{ userId: string; error: string }> = [];

    for (const instance of activeInstances) {
      const destroyedRow = await markActiveInstanceDestroyed(instance.user_id, instance.id);
      try {
        await client.destroy(instance.user_id, workerInstanceId(instance));
        destroyed++;
      } catch (err) {
        if (destroyedRow) {
          await restoreDestroyedInstance(destroyedRow.id);
        }
        const message = err instanceof Error ? err.message : 'Unknown error';
        errors.push({ userId: instance.user_id, error: message });
        console.error(
          `[admin-kiloclaw] DevNukeAll: failed to destroy instance ${instance.id} (user: ${instance.user_id}):`,
          err
        );
      }
    }

    return { total: activeInstances.length, destroyed, errors };
  }),

  reassociateVolume: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        newVolumeId: z.string().min(1),
        reason: z.string().min(10).max(500),
      })
    )
    .mutation(async ({ input, ctx }): Promise<ReassociateVolumeResponse> => {
      console.log(
        `[admin-kiloclaw] Volume reassociation triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) for user ${input.userId}: newVolume=${input.newVolumeId} reason="${input.reason}"`
      );
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        const result = await client.reassociateVolume(
          input.userId,
          input.newVolumeId,
          input.reason,
          workerInstanceId(instance)
        );

        try {
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.volume.reassociate',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: input.userId,
            message: `Volume reassociated: ${result.previousVolumeId ?? 'none'} → ${result.newVolumeId} (region: ${result.newRegion}). Reason: ${input.reason}`,
            metadata: {
              previousVolumeId: result.previousVolumeId,
              newVolumeId: result.newVolumeId,
              newRegion: result.newRegion,
              reason: input.reason,
            },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for volume reassociation:', auditErr);
        }

        return result;
      } catch (err) {
        console.error('Failed to reassociate volume for user:', input.userId, err);
        throwKiloclawAdminError(err, 'Failed to reassociate volume');
      }
    }),

  resizeMachine: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        machineSize: z.object({
          cpus: z.number().int().min(1).max(8),
          memory_mb: z.number().int().min(256).max(16384),
          cpu_kind: z.enum(['shared', 'performance']).optional(),
        }),
      })
    )
    .mutation(async ({ input, ctx }): Promise<ResizeMachineResponse> => {
      console.log(
        `[admin-kiloclaw] Machine resize triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) for user ${input.userId}: ${JSON.stringify(input.machineSize)}`
      );
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        const result = await client.resizeMachine(
          input.userId,
          input.machineSize,
          workerInstanceId(instance)
        );

        try {
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.machine.resize',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: input.userId,
            message: `Machine resized: ${JSON.stringify(result.previousSize)} → ${JSON.stringify(result.newSize)}`,
            metadata: {
              previousSize: result.previousSize,
              newSize: result.newSize,
            },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for machine resize:', auditErr);
        }

        return result;
      } catch (err) {
        console.error('Failed to resize machine for user:', input.userId, err);
        throwKiloclawAdminError(err, 'Failed to resize machine');
      }
    }),

  restoreVolumeSnapshot: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        instanceId: z.string().uuid().optional(),
        snapshotId: z.string().min(1),
        reason: z.string().min(10).max(500),
      })
    )
    .mutation(async ({ input, ctx }): Promise<RestoreVolumeSnapshotResponse> => {
      console.log(
        `[admin-kiloclaw] Snapshot restore triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) for user ${input.userId}: snapshot=${input.snapshotId} reason="${input.reason}"`
      );
      try {
        const instance = await resolveInstance(input.userId, input.instanceId);
        const client = new KiloClawInternalClient();
        const result = await client.restoreVolumeFromSnapshot(
          input.userId,
          input.snapshotId,
          workerInstanceId(instance)
        );

        try {
          await createKiloClawAdminAuditLog({
            action: 'kiloclaw.snapshot.restore',
            actor_id: ctx.user.id,
            actor_email: ctx.user.google_user_email,
            actor_name: ctx.user.google_user_name,
            target_user_id: input.userId,
            message: `Snapshot restore enqueued: snapshot=${input.snapshotId}, previousVolume=${result.previousVolumeId}. Reason: ${input.reason}`,
            metadata: {
              snapshotId: input.snapshotId,
              previousVolumeId: result.previousVolumeId,
              reason: input.reason,
            },
          });
        } catch (auditErr) {
          console.error('Failed to write audit log for snapshot restore:', auditErr);
        }

        return result;
      } catch (err) {
        console.error('Failed to restore snapshot for user:', input.userId, err);
        throwKiloclawAdminError(err, 'Failed to restore from snapshot');
      }
    }),

  // ── Orphan detection ──────────────────────────────────────────────────

  detectOrphans: adminProcedure.input(DetectOrphansSchema).mutation(async ({ input }) => {
    // 1. Fetch all active (non-destroyed) instances created within the date range.
    //    Cap at 1000 to avoid excessively long fan-outs; the UI shows when capped.
    const MAX_SCAN = 1000;
    const instances = await db
      .select({
        id: kiloclaw_instances.id,
        user_id: kiloclaw_instances.user_id,
        sandbox_id: kiloclaw_instances.sandbox_id,
        organization_id: kiloclaw_instances.organization_id,
        created_at: kiloclaw_instances.created_at,
        user_email: kilocode_users.google_user_email,
        subscription_id: kiloclaw_subscriptions.id,
        subscription_status: kiloclaw_subscriptions.status,
      })
      .from(kiloclaw_instances)
      .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_instances.id, kiloclaw_subscriptions.instance_id)
      )
      .where(
        and(
          isNull(kiloclaw_instances.destroyed_at),
          gte(kiloclaw_instances.created_at, input.createdAfter),
          lte(kiloclaw_instances.created_at, input.createdBefore)
        )
      )
      .orderBy(desc(kiloclaw_instances.created_at))
      .limit(MAX_SCAN + 1);

    const capped = instances.length > MAX_SCAN;
    const toScan = capped ? instances.slice(0, MAX_SCAN) : instances;

    if (toScan.length === 0) {
      return { orphans: [], scanned: 0, capped: false };
    }

    // 2. Fan out getDebugStatus calls with concurrency limit.
    const CONCURRENCY = 10;
    const client = new KiloClawInternalClient();

    type OrphanResult = {
      id: string;
      user_id: string;
      sandbox_id: string;
      organization_id: string | null;
      created_at: string;
      user_email: string | null;
      subscription_id: string | null;
      subscription_status: string | null;
      workerStatusError: string | null;
    };

    const orphans: OrphanResult[] = [];

    for (let i = 0; i < toScan.length; i += CONCURRENCY) {
      const batch = toScan.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(
        batch.map(async instance => {
          const instId = instance.sandbox_id.startsWith('ki_') ? instance.id : undefined;
          const status = await client.getDebugStatus(instance.user_id, instId);
          return { instance, status };
        })
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        if (result.status === 'fulfilled') {
          const { instance, status } = result.value;
          // A null/undefined status means the DO has never been provisioned.
          if (!status?.status) {
            orphans.push({
              id: instance.id,
              user_id: instance.user_id,
              sandbox_id: instance.sandbox_id,
              organization_id: instance.organization_id,
              created_at: instance.created_at,
              user_email: instance.user_email,
              subscription_id: instance.subscription_id,
              subscription_status: instance.subscription_status,
              workerStatusError: null,
            });
          }
        } else {
          // If the status call itself failed, flag it as a potential orphan
          // with the error — the admin can investigate.
          const instance = batch[j];
          if (instance) {
            orphans.push({
              id: instance.id,
              user_id: instance.user_id,
              sandbox_id: instance.sandbox_id,
              organization_id: instance.organization_id,
              created_at: instance.created_at,
              user_email: instance.user_email,
              subscription_id: instance.subscription_id,
              subscription_status: instance.subscription_status,
              workerStatusError:
                result.reason instanceof Error ? result.reason.message : 'Status check failed',
            });
          }
        }
      }
    }

    return { orphans, scanned: toScan.length, capped };
  }),

  destroyOrphan: adminProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ input, ctx }) => {
      // Verify the instance exists and is not already destroyed.
      const [instance] = await db
        .select({
          id: kiloclaw_instances.id,
          user_id: kiloclaw_instances.user_id,
          sandbox_id: kiloclaw_instances.sandbox_id,
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

      // Verify the instance is actually an orphan — the DO should have no state.
      // If it does, the admin should use the standard destroy flow instead.
      const client = new KiloClawInternalClient();
      const instId = instance.sandbox_id.startsWith('ki_') ? instance.id : undefined;
      const workerStatus = await client.getDebugStatus(instance.user_id, instId);
      if (workerStatus?.status) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Instance has active DO state (status: ${workerStatus.status}) — use the standard destroy flow instead`,
        });
      }

      console.log(
        `[admin-kiloclaw] Orphan cleanup by admin ${ctx.user.id} (${ctx.user.google_user_email}) for instance ${instance.id} (user: ${instance.user_id})`
      );

      // Soft-delete the DB row. No DO destroy needed — the DO was never
      // provisioned (that's what makes it an orphan).
      await markInstanceDestroyedById(instance.id);

      try {
        await createKiloClawAdminAuditLog({
          action: 'kiloclaw.orphan.destroy',
          actor_id: ctx.user.id,
          actor_email: ctx.user.google_user_email,
          actor_name: ctx.user.google_user_name,
          target_user_id: instance.user_id,
          message: `Orphaned instance destroyed: ${instance.sandbox_id}`,
          metadata: {
            reason: 'Orphaned instance — active DB row with no backing Durable Object',
            instance_id: instance.id,
            sandbox_id: instance.sandbox_id,
          },
        });
      } catch (auditErr) {
        console.error('[admin-kiloclaw] Failed to write audit log for orphan destroy:', auditErr);
      }

      return { success: true };
    }),
});
