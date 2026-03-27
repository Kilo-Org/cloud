import { adminProcedure, createTRPCRouter, UpstreamApiError } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  kiloclaw_instances,
  kiloclaw_subscriptions,
  kiloclaw_email_log,
  kilocode_users,
} from '@kilocode/db/schema';
import { KiloClawInternalClient, KiloClawApiError } from '@/lib/kiloclaw/kiloclaw-internal-client';
import { KiloClawUserClient } from '@/lib/kiloclaw/kiloclaw-user-client';
import {
  markActiveInstanceDestroyed,
  restoreDestroyedInstance,
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

export type AdminKiloclawInstance = {
  id: string;
  user_id: string;
  sandbox_id: string;
  created_at: string;
  destroyed_at: string | null;
  suspended_at: string | null;
  user_email: string | null;
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
      })
      .from(kiloclaw_instances)
      .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_instances.user_id, kiloclaw_subscriptions.user_id)
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
      created_at: result.instance.created_at,
      destroyed_at: result.instance.destroyed_at,
      suspended_at: result.suspended_at ?? null,
      user_email: result.user_email,
    };

    const derivedFlyAppName = flyAppNameFromUserId(instance.user_id);

    // Fetch live worker status for all instances.
    // DB may be marked destroyed while DO is still retrying destroy.
    let workerStatus: PlatformDebugStatusResponse | null = null;
    let workerStatusError: string | null = null;

    try {
      const client = new KiloClawInternalClient();
      workerStatus = await client.getDebugStatus(instance.user_id);
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
      })
      .from(kiloclaw_instances)
      .leftJoin(kilocode_users, eq(kiloclaw_instances.user_id, kilocode_users.id))
      .leftJoin(
        kiloclaw_subscriptions,
        eq(kiloclaw_instances.user_id, kiloclaw_subscriptions.user_id)
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
        eq(kiloclaw_instances.user_id, kiloclaw_subscriptions.user_id)
      )
      .where(whereCondition);

    const totalCount = totalCountResult[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limit);

    const instances: AdminKiloclawInstance[] = instancesResult.map(row => ({
      id: row.instance.id,
      user_id: row.instance.user_id,
      sandbox_id: row.instance.sandbox_id,
      created_at: row.instance.created_at,
      destroyed_at: row.instance.destroyed_at,
      suspended_at: row.suspended_at ?? null,
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
        eq(kiloclaw_instances.user_id, kiloclaw_subscriptions.user_id)
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
        const client = new KiloClawInternalClient();
        return await client.listVolumeSnapshots(input.userId);
      } catch (err) {
        console.error('Failed to fetch volume snapshots for user:', input.userId, err);
        throwKiloclawAdminError(err, fallbackMessage);
      }
    }),

  controllerVersion: adminProcedure.input(GatewayProcessSchema).query(async ({ input }) => {
    const fallbackMessage = 'Failed to fetch controller version';
    try {
      const client = new KiloClawInternalClient();
      return await client.getControllerVersion(input.userId);
    } catch (err) {
      console.error('Failed to fetch controller version for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  gatewayStatus: adminProcedure.input(GatewayProcessSchema).query(async ({ input }) => {
    const fallbackMessage = 'Failed to fetch gateway status';
    try {
      const client = new KiloClawInternalClient();
      return await client.getGatewayStatus(input.userId);
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
      const client = new KiloClawInternalClient();
      return await client.startGateway(input.userId);
    } catch (err) {
      console.error('Failed to start gateway for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  gatewayStop: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to stop gateway';
    try {
      const client = new KiloClawInternalClient();
      return await client.stopGateway(input.userId);
    } catch (err) {
      console.error('Failed to stop gateway for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  gatewayRestart: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to restart gateway';
    try {
      const client = new KiloClawInternalClient();
      return await client.restartGatewayProcess(input.userId);
    } catch (err) {
      console.error('Failed to restart gateway for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  runDoctor: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to run doctor';
    try {
      const client = new KiloClawInternalClient();
      return await client.runDoctor(input.userId);
    } catch (err) {
      console.error('Failed to run doctor for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  restoreConfig: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to restore config';
    try {
      const client = new KiloClawInternalClient();
      return await client.restoreConfig(input.userId);
    } catch (err) {
      console.error('Failed to restore config for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  fileTree: adminProcedure
    .input(z.object({ userId: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        const client = new KiloClawInternalClient();
        const result = await client.getFileTree(input.userId);
        return result.tree;
      } catch (err) {
        throwKiloclawAdminError(err, 'Failed to fetch file tree');
      }
    }),

  readFile: adminProcedure
    .input(z.object({ userId: z.string().min(1), path: z.string().min(1) }))
    .query(async ({ input }) => {
      try {
        const client = new KiloClawInternalClient();
        return await client.readFile(input.userId, input.path);
      } catch (err) {
        throwKiloclawAdminError(err, 'Failed to read file');
      }
    }),

  writeFile: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        path: z.string().min(1),
        content: z.string(),
        etag: z.string().optional(),
      })
    )
    .mutation(async ({ input }) => {
      try {
        const client = new KiloClawInternalClient();
        return await client.writeFile(input.userId, input.path, input.content, input.etag);
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
      const client = new KiloClawInternalClient();
      return await client.start(input.userId, undefined, { skipCooldown: true });
    } catch (err) {
      console.error('Failed to start machine for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  forceRetryRecovery: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to retry recovery';
    try {
      const client = new KiloClawInternalClient();
      return await client.forceRetryRecovery(input.userId);
    } catch (err) {
      console.error('Failed to retry recovery for user:', input.userId, err);
      throwKiloclawAdminError(err, fallbackMessage);
    }
  }),

  machineStop: adminProcedure.input(GatewayProcessSchema).mutation(async ({ input }) => {
    const fallbackMessage = 'Failed to stop machine';
    try {
      const client = new KiloClawInternalClient();
      return await client.stop(input.userId);
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
        .select({ user: kilocode_users })
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
          { userId: row.user.id }
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
      const client = new KiloClawInternalClient();

      // Verify the appName/machineId match the DO's actual state
      let status: Awaited<ReturnType<KiloClawInternalClient['getDebugStatus']>>;
      try {
        status = await client.getDebugStatus(input.userId);
      } catch (err) {
        throwKiloclawAdminError(err, 'Failed to verify machine state before destroy');
      }
      if (status.flyAppName !== input.appName || status.flyMachineId !== input.machineId) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: `Fly resource mismatch: expected app=${status.flyAppName} machine=${status.flyMachineId}, got app=${input.appName} machine=${input.machineId}`,
        });
      }

      const fallbackMessage = 'Failed to destroy Fly machine';
      try {
        const result = await client.destroyFlyMachine(input.userId, input.appName, input.machineId);

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

    // Post-destroy cleanup: best-effort DB tidying that must not report
    // failure after a successful destroy.
    try {
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
    .input(z.object({ userId: z.string().min(1) }))
    .query(async ({ input }): Promise<CandidateVolumesResponse> => {
      try {
        const client = new KiloClawInternalClient();
        return await client.listCandidateVolumes(input.userId);
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
      const destroyedRow = await markActiveInstanceDestroyed(instance.user_id);
      try {
        await client.destroy(instance.user_id);
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
        newVolumeId: z.string().min(1),
        reason: z.string().min(10).max(500),
      })
    )
    .mutation(async ({ input, ctx }): Promise<ReassociateVolumeResponse> => {
      console.log(
        `[admin-kiloclaw] Volume reassociation triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) for user ${input.userId}: newVolume=${input.newVolumeId} reason="${input.reason}"`
      );
      try {
        const client = new KiloClawInternalClient();
        const result = await client.reassociateVolume(
          input.userId,
          input.newVolumeId,
          input.reason
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

  restoreVolumeSnapshot: adminProcedure
    .input(
      z.object({
        userId: z.string().min(1),
        snapshotId: z.string().min(1),
        reason: z.string().min(10).max(500),
      })
    )
    .mutation(async ({ input, ctx }): Promise<RestoreVolumeSnapshotResponse> => {
      console.log(
        `[admin-kiloclaw] Snapshot restore triggered by admin ${ctx.user.id} (${ctx.user.google_user_email}) for user ${input.userId}: snapshot=${input.snapshotId} reason="${input.reason}"`
      );
      try {
        const client = new KiloClawInternalClient();
        const result = await client.restoreVolumeFromSnapshot(input.userId, input.snapshotId);

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
});
