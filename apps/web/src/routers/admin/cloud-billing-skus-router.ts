import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  cloudBillingSkuIdSchema,
  createCloudBillingSkuInputSchema,
  normalizeCloudBillingSkuRate,
} from '@/lib/cloud-billing-sku';
import {
  cloud_billing_sku,
  container_usage_interval,
  container_usage_segment,
  type CloudBillingSku,
  type ContainerUsageInterval,
  type ContainerUsageSegment,
} from '@kilocode/db/schema';
import { TRPCError } from '@trpc/server';
import { and, desc, eq, gt, lt, or, sql, type SQL } from 'drizzle-orm';
import * as z from 'zod';

export type SerializedCloudBillingSku = Omit<CloudBillingSku, 'created_at'> & {
  created_at: string;
};

export function serializeCloudBillingSku(sku: CloudBillingSku): SerializedCloudBillingSku {
  return {
    ...sku,
    rate_cents_per_unit: normalizeCloudBillingSkuRate(sku.rate_cents_per_unit),
    created_at: new Date(sku.created_at).toISOString(),
  };
}

const usageSearchSchema = z
  .object({
    search: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('recent') }),
      z.object({ kind: z.literal('interval'), id: z.string().trim().min(1).max(512) }),
      z.object({
        kind: z.literal('subject'),
        subjectType: z.enum(['user', 'org']),
        subjectId: z.string().trim().min(1).max(256),
      }),
    ]),
    status: z.enum(['open', 'closed']).optional(),
    closeReason: z
      .enum([
        'exit',
        'runtime_signal',
        'activity_expired',
        'reconciled',
        'unconfirmed',
        'superseded',
      ])
      .optional(),
    skuId: cloudBillingSkuIdSchema.optional(),
    cursor: z
      .object({ startedAt: z.iso.datetime(), id: z.string().min(1).max(512) })
      .strict()
      .optional(),
    limit: z.number().int().min(1).max(100).default(25),
  })
  .strict();

const segmentSearchSchema = z
  .object({
    intervalId: z.string().trim().min(1).max(512),
    afterSeq: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();

const BILLING_HEALTH_WINDOW_MS = 24 * 60 * 60 * 1_000;
const STALE_OPEN_INTERVAL_MS = 15 * 60 * 1_000;
const usageMetadataSchema = z
  .record(z.string().min(1).max(64), z.string().max(512))
  .refine(
    metadata => Object.keys(metadata).length <= 16,
    'Metadata may contain at most 16 entries'
  );

export type SerializedUsageInterval = Pick<
  ContainerUsageInterval,
  | 'id'
  | 'service'
  | 'instance_id'
  | 'start_epoch_ms'
  | 'cloud_billing_sku_id'
  | 'subject_type'
  | 'subject_id'
  | 'actor_type'
  | 'actor_id'
  | 'last_heartbeat_seq'
  | 'confirmed_seconds'
  | 'close_reason'
  | 'exit_code'
  | 'final_stop_seq'
  | 'status'
> & {
  started_at: string;
  last_seen_at: string;
  stopped_at: string | null;
};

export function serializeUsageInterval(interval: ContainerUsageInterval): SerializedUsageInterval {
  return {
    id: interval.id,
    service: interval.service,
    instance_id: interval.instance_id,
    start_epoch_ms: interval.start_epoch_ms,
    cloud_billing_sku_id: interval.cloud_billing_sku_id,
    subject_type: interval.subject_type,
    subject_id: interval.subject_id,
    actor_type: interval.actor_type,
    actor_id: interval.actor_id,
    last_heartbeat_seq: interval.last_heartbeat_seq,
    confirmed_seconds: interval.confirmed_seconds,
    close_reason: interval.close_reason,
    exit_code: interval.exit_code,
    final_stop_seq: interval.final_stop_seq,
    status: interval.status,
    started_at: new Date(interval.started_at).toISOString(),
    last_seen_at: new Date(interval.last_seen_at).toISOString(),
    stopped_at: interval.stopped_at ? new Date(interval.stopped_at).toISOString() : null,
  };
}

export type SerializedUsageSegment = Pick<
  ContainerUsageSegment,
  'interval_id' | 'seq' | 'reported_seconds' | 'usage_seconds'
> & {
  received_at: string;
};

export function serializeUsageSegment(segment: ContainerUsageSegment): SerializedUsageSegment {
  return {
    interval_id: segment.interval_id,
    seq: segment.seq,
    reported_seconds: segment.reported_seconds,
    usage_seconds: segment.usage_seconds,
    received_at: new Date(segment.received_at).toISOString(),
  };
}

function parseUsageMetadata(metadata: unknown): Record<string, string> {
  const parsed = usageMetadataSchema.safeParse(metadata ?? {});
  if (!parsed.success) {
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Stored usage metadata is invalid',
    });
  }
  return parsed.data;
}

function postgresErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  if ('code' in error && typeof error.code === 'string') return error.code;
  if ('cause' in error) return postgresErrorCode(error.cause);
  return undefined;
}

export const cloudBillingSkusRouter = createTRPCRouter({
  list: adminProcedure.query(async (): Promise<SerializedCloudBillingSku[]> => {
    const rows = await db
      .select()
      .from(cloud_billing_sku)
      .orderBy(desc(cloud_billing_sku.created_at));
    return rows.map(serializeCloudBillingSku);
  }),

  searchUsageIntervals: adminProcedure.input(usageSearchSchema).query(async ({ input }) => {
    const predicates: SQL[] = [];
    if (input.search.kind === 'recent') {
      const sharedPredicates: SQL[] = [];
      if (input.closeReason || input.skuId) {
        const recentCutoff = new Date(Date.now() - BILLING_HEALTH_WINDOW_MS).toISOString();
        sharedPredicates.push(gt(container_usage_interval.last_seen_at, recentCutoff));
      }
      if (input.closeReason) {
        sharedPredicates.push(eq(container_usage_interval.close_reason, input.closeReason));
      }
      if (input.skuId) {
        sharedPredicates.push(eq(container_usage_interval.cloud_billing_sku_id, input.skuId));
      }
      const statuses = input.status
        ? [input.status]
        : input.closeReason
          ? ['closed' as const]
          : (['open', 'closed'] as const);
      const pages = await Promise.all(
        statuses.map(status =>
          db
            .select()
            .from(container_usage_interval)
            .where(and(eq(container_usage_interval.status, status), ...sharedPredicates))
            .orderBy(desc(container_usage_interval.last_seen_at), desc(container_usage_interval.id))
            .limit(input.limit)
        )
      );
      const items = pages
        .flat()
        .sort((left, right) => {
          const byLastSeen =
            new Date(right.last_seen_at).getTime() - new Date(left.last_seen_at).getTime();
          return byLastSeen || right.id.localeCompare(left.id);
        })
        .slice(0, input.limit)
        .map(serializeUsageInterval);
      return { items, nextCursor: null };
    }
    if (input.search.kind === 'interval') {
      predicates.push(eq(container_usage_interval.id, input.search.id));
    } else {
      predicates.push(
        eq(container_usage_interval.subject_type, input.search.subjectType),
        eq(container_usage_interval.subject_id, input.search.subjectId)
      );
    }
    if (input.status) predicates.push(eq(container_usage_interval.status, input.status));
    if (input.closeReason) {
      predicates.push(eq(container_usage_interval.close_reason, input.closeReason));
    }
    if (input.skuId) {
      predicates.push(eq(container_usage_interval.cloud_billing_sku_id, input.skuId));
    }
    if (input.cursor) {
      const startedAt = input.cursor.startedAt;
      const sameTimestamp = and(
        eq(container_usage_interval.started_at, startedAt),
        lt(container_usage_interval.id, input.cursor.id)
      );
      const cursorPredicate = sameTimestamp
        ? or(lt(container_usage_interval.started_at, startedAt), sameTimestamp)
        : lt(container_usage_interval.started_at, startedAt);
      if (cursorPredicate) predicates.push(cursorPredicate);
    }

    const rows = await db
      .select()
      .from(container_usage_interval)
      .where(and(...predicates))
      .orderBy(desc(container_usage_interval.started_at), desc(container_usage_interval.id))
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      items: page.map(serializeUsageInterval),
      nextCursor:
        hasMore && last
          ? { startedAt: new Date(last.started_at).toISOString(), id: last.id }
          : null,
    };
  }),

  listUsageSegments: adminProcedure.input(segmentSearchSchema).query(async ({ input }) => {
    const [interval] = await db
      .select({ id: container_usage_interval.id, metadata: container_usage_interval.metadata })
      .from(container_usage_interval)
      .where(eq(container_usage_interval.id, input.intervalId))
      .limit(1);
    if (!interval) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Usage interval not found' });
    }
    const predicates = [eq(container_usage_segment.interval_id, input.intervalId)];
    if (input.afterSeq) predicates.push(gt(container_usage_segment.seq, input.afterSeq));
    const rows = await db
      .select()
      .from(container_usage_segment)
      .where(and(...predicates))
      .orderBy(container_usage_segment.seq)
      .limit(input.limit + 1);
    const hasMore = rows.length > input.limit;
    const page = rows.slice(0, input.limit);
    return {
      metadata: parseUsageMetadata(interval.metadata),
      items: page.map(serializeUsageSegment),
      nextCursor: hasMore ? (page.at(-1)?.seq ?? null) : null,
    };
  }),

  usageHealth: adminProcedure.query(async () => {
    const end = new Date();
    const start = new Date(end.getTime() - BILLING_HEALTH_WINDOW_MS);
    const staleBefore = new Date(end.getTime() - STALE_OPEN_INTERVAL_MS);
    const [openRows, segmentRows, closeReasonRows] = await Promise.all([
      db
        .select({
          open: sql<number>`count(*)`.mapWith(Number),
          stale:
            sql<number>`count(*) FILTER (WHERE ${container_usage_interval.last_seen_at} < ${staleBefore.toISOString()})`.mapWith(
              Number
            ),
        })
        .from(container_usage_interval)
        .where(eq(container_usage_interval.status, 'open')),
      db
        .select({
          segments: sql<number>`count(*)`.mapWith(Number),
          intervalsReported:
            sql<number>`count(distinct ${container_usage_segment.interval_id})`.mapWith(Number),
          reportedSeconds:
            sql<number>`coalesce(sum(${container_usage_segment.reported_seconds}), 0)`.mapWith(
              Number
            ),
          acceptedSeconds:
            sql<number>`coalesce(sum(${container_usage_segment.usage_seconds}), 0)`.mapWith(Number),
          clippedSeconds:
            sql<number>`coalesce(sum(${container_usage_segment.reported_seconds} - ${container_usage_segment.usage_seconds}), 0)`.mapWith(
              Number
            ),
          clippedSegments:
            sql<number>`count(*) FILTER (WHERE ${container_usage_segment.usage_seconds} < ${container_usage_segment.reported_seconds})`.mapWith(
              Number
            ),
        })
        .from(container_usage_segment)
        .where(
          and(
            gt(container_usage_segment.received_at, start.toISOString()),
            lt(container_usage_segment.received_at, end.toISOString())
          )
        ),
      db
        .select({
          reason: container_usage_interval.close_reason,
          count: sql<number>`count(*)`.mapWith(Number),
        })
        .from(container_usage_interval)
        .where(
          and(
            eq(container_usage_interval.status, 'closed'),
            gt(container_usage_interval.last_seen_at, start.toISOString()),
            lt(container_usage_interval.last_seen_at, end.toISOString())
          )
        )
        .groupBy(container_usage_interval.close_reason)
        .orderBy(desc(sql`count(*)`)),
    ]);
    const closeReasons = closeReasonRows.map(row => ({
      reason: row.reason ?? 'unknown',
      count: row.count,
    }));
    return {
      generatedAt: end.toISOString(),
      periodStart: start.toISOString(),
      intervalsReported: segmentRows[0]?.intervalsReported ?? 0,
      openIntervals: openRows[0]?.open ?? 0,
      staleOpenIntervals: openRows[0]?.stale ?? 0,
      closedIntervalsWithRecentActivity: closeReasons.reduce((total, row) => total + row.count, 0),
      unconfirmedIntervalsWithRecentActivity:
        closeReasons.find(row => row.reason === 'unconfirmed')?.count ?? 0,
      segments: segmentRows[0]?.segments ?? 0,
      reportedSeconds: segmentRows[0]?.reportedSeconds ?? 0,
      acceptedSeconds: segmentRows[0]?.acceptedSeconds ?? 0,
      clippedSeconds: segmentRows[0]?.clippedSeconds ?? 0,
      clippedSegments: segmentRows[0]?.clippedSegments ?? 0,
      closeReasonsByLastActivity: closeReasons,
    };
  }),

  create: adminProcedure
    .input(createCloudBillingSkuInputSchema)
    .mutation(async ({ input, ctx }): Promise<SerializedCloudBillingSku> => {
      try {
        const [created] = await db
          .insert(cloud_billing_sku)
          .values({
            id: input.id,
            name: input.name,
            description: input.description,
            unit: input.unit,
            rate_cents_per_unit: input.rate_cents_per_unit,
            created_by_user_id: ctx.user.id,
          })
          .returning();
        return serializeCloudBillingSku(created);
      } catch (error) {
        if (postgresErrorCode(error) === '23505') {
          throw new TRPCError({ code: 'CONFLICT', message: 'A billing SKU with this ID exists' });
        }
        throw error;
      }
    }),

  disable: adminProcedure
    .input(z.object({ id: cloudBillingSkuIdSchema }))
    .mutation(async ({ input }): Promise<SerializedCloudBillingSku> => {
      const [updated] = await db
        .update(cloud_billing_sku)
        .set({ accepts_new_usage: false })
        .where(eq(cloud_billing_sku.id, input.id))
        .returning();
      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Billing SKU not found' });
      }
      return serializeCloudBillingSku(updated);
    }),
});
