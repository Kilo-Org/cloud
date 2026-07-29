import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { db } from '@/lib/drizzle';
import {
  cloudBillingSkuIdSchema,
  createCloudBillingSkuInputSchema,
  normalizeCloudBillingSkuRate,
} from '@/lib/cloud-billing-sku';
import {
  ContainerUsageAnalyticsError,
  queryContainerUsageAnalytics,
  type ContainerUsageAnalyticsResult,
} from '@/lib/cloudflare/container-usage-analytics';
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
        start: z.iso.datetime(),
        end: z.iso.datetime(),
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
  .strict()
  .superRefine((input, context) => {
    if (input.search.kind !== 'subject') return;
    validateUsageWindow(input.search.start, input.search.end, context);
  });

const segmentSearchSchema = z
  .object({
    intervalId: z.string().trim().min(1).max(512),
    afterSeq: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(500).default(200),
  })
  .strict();

const usageSummarySchema = z
  .object({
    subjectType: z.enum(['user', 'org']),
    subjectId: z.string().trim().min(1).max(256),
    start: z.iso.datetime(),
    end: z.iso.datetime(),
  })
  .strict()
  .superRefine((input, context) => {
    validateUsageWindow(input.start, input.end, context);
  });

const BILLING_HEALTH_WINDOW_MS = 24 * 60 * 60 * 1_000;
const STALE_OPEN_INTERVAL_MS = 15 * 60 * 1_000;
const MAX_RECONCILIATION_INSTANCES = 100;
const MEBIBYTE_BYTES = 1024 ** 2;
const MEGABYTE_BYTES = 1_000_000;
const CAPACITY_CROSS_CHECK_RELATIVE_TOLERANCE = 1e-6;
const COMPARISON_METHOD =
  'Provider awake seconds use allocated memory byte-seconds divided by the provisioned memory for the recorded service class. Difference is provider minus meter.';
const usageMetadataSchema = z
  .record(z.string().min(1).max(64), z.string().max(512))
  .refine(
    metadata => Object.keys(metadata).length <= 16,
    'Metadata may contain at most 16 entries'
  );

function validateUsageWindow(startValue: string, endValue: string, context: z.RefinementCtx): void {
  const start = new Date(startValue).getTime();
  const end = new Date(endValue).getTime();
  if (end <= start) {
    context.addIssue({ code: 'custom', path: ['end'], message: 'End must be after start' });
    return;
  }
  if (end - start > 31 * 24 * 60 * 60 * 1_000) {
    context.addIssue({
      code: 'custom',
      path: ['end'],
      message: 'Usage windows may not exceed 31 days',
    });
  }
}

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

type ReconciliationStatus =
  | 'matched'
  | 'missing_from_cloudflare'
  | 'ambiguous_application'
  | 'provider_partial'
  | 'comparison_unavailable';

type MeterReconciliationRow = {
  key: string;
  providerInstanceId: string | null;
  meterInstanceIds: Set<string>;
  services: Set<string>;
  skuIds: Set<string>;
  intervalIds: Set<string>;
  acceptedSeconds: number;
  identityIssue: string | null;
};

const cloudAgentProviderIdentitySchema = z
  .object({ durable_object_id: z.string().trim().min(1).max(256) })
  .passthrough();

function providerIdentityForMeterRow(row: {
  service: string;
  instanceId: string;
  metadata: unknown;
}): { instanceId: string | null; issue: string | null } {
  if (row.service === 'gastown') {
    return { instanceId: row.instanceId, issue: null };
  }
  if (row.service === 'cloud-agent-next' || row.service.startsWith('cloud-agent-next-')) {
    const metadata = cloudAgentProviderIdentitySchema.safeParse(row.metadata);
    if (!metadata.success) {
      return {
        instanceId: null,
        issue: 'Cloud Agent usage metadata does not contain a valid durable_object_id.',
      };
    }
    return {
      instanceId: metadata.data.durable_object_id,
      issue: null,
    };
  }
  return {
    instanceId: null,
    issue: `Service ${row.service} has no Cloudflare physical-identity mapping.`,
  };
}

// Cloud Agent values mirror services/cloud-agent-next/wrangler.jsonc. Gastown
// uses Cloudflare standard-4, documented as 12 GiB of provisioned memory.
type ProvisionedCapacity = { memoryBytes: number; diskBytes: number };

function provisionedCapacityForService(service: string): ProvisionedCapacity | null {
  switch (service) {
    case 'gastown':
    case 'cloud-agent-next-sandbox':
    case 'cloud-agent-next-sandbox-containment':
      return { memoryBytes: 12_288 * MEBIBYTE_BYTES, diskBytes: 20_000 * MEGABYTE_BYTES };
    case 'cloud-agent-next-sandbox-small':
    case 'cloud-agent-next-sandbox-dind':
    case 'cloud-agent-next-sandbox-small-containment':
      return { memoryBytes: 6_144 * MEBIBYTE_BYTES, diskBytes: 10_000 * MEGABYTE_BYTES };
    case 'cloud-agent-next-sandbox-code-review':
    case 'cloud-agent-next-sandbox-code-review-containment':
      return { memoryBytes: 4_096 * MEBIBYTE_BYTES, diskBytes: 8_000 * MEGABYTE_BYTES };
    default:
      return null;
  }
}

function addMeterReconciliationRow(
  rows: Map<string, MeterReconciliationRow>,
  meter: {
    intervalId: string;
    service: string;
    instanceId: string;
    skuId: string;
    metadata: unknown;
    acceptedSeconds: number;
  }
): void {
  const providerIdentity = providerIdentityForMeterRow(meter);
  const key = providerIdentity.instanceId
    ? `provider\0${providerIdentity.instanceId}`
    : `meter\0${meter.service}\0${meter.instanceId}`;
  let row = rows.get(key);
  if (!row) {
    row = {
      key,
      providerInstanceId: providerIdentity.instanceId,
      meterInstanceIds: new Set(),
      services: new Set(),
      skuIds: new Set(),
      intervalIds: new Set(),
      acceptedSeconds: 0,
      identityIssue: providerIdentity.issue,
    };
    rows.set(key, row);
  }
  row.meterInstanceIds.add(meter.instanceId);
  row.services.add(meter.service);
  row.skuIds.add(meter.skuId);
  row.intervalIds.add(meter.intervalId);
  row.acceptedSeconds += meter.acceptedSeconds;
  if (providerIdentity.issue) row.identityIssue = providerIdentity.issue;
}

function providerErrorCode(
  error: ContainerUsageAnalyticsError
): 'PRECONDITION_FAILED' | 'BAD_GATEWAY' {
  return error.code === 'missing_config' ||
    error.code === 'outside_retention' ||
    error.code === 'request_limit_exceeded' ||
    error.code === 'dataset_unavailable' ||
    error.code === 'dataset_disabled' ||
    error.code === 'fields_unavailable'
    ? 'PRECONDITION_FAILED'
    : 'BAD_GATEWAY';
}

function normalizedReconciliationRows(
  meterRows: MeterReconciliationRow[],
  provider: ContainerUsageAnalyticsResult | null
) {
  const providerByInstance = new Map<string, ContainerUsageAnalyticsResult['rows']>();
  const partialUsageInstanceIds = new Set(provider?.usagePartialInstanceIds ?? []);
  for (const row of provider?.rows ?? []) {
    const existing = providerByInstance.get(row.instanceId);
    if (existing) existing.push(row);
    else providerByInstance.set(row.instanceId, [row]);
  }

  return meterRows.map(meter => {
    const candidates = meter.providerInstanceId
      ? (providerByInstance.get(meter.providerInstanceId) ?? [])
      : [];
    const providerApplicationIds = candidates.map(candidate => candidate.applicationId).sort();
    let status: ReconciliationStatus;
    let statusDetail: string;
    let matchedProvider = null as ContainerUsageAnalyticsResult['rows'][number] | null;
    let providerComparisonSeconds: number | null = null;
    let providerMemorySeconds: number | null = null;
    let providerDiskSeconds: number | null = null;
    let provisionedMemoryBytes: number | null = null;
    let provisionedDiskBytes: number | null = null;
    let differenceSeconds: number | null = null;
    let differencePercent: number | null = null;
    if (meter.identityIssue) {
      status = 'comparison_unavailable';
      statusDetail = meter.identityIssue;
    } else if (candidates.length === 0) {
      const usagePartial =
        meter.providerInstanceId !== null && partialUsageInstanceIds.has(meter.providerInstanceId);
      status = usagePartial ? 'provider_partial' : 'missing_from_cloudflare';
      statusDetail = usagePartial
        ? 'Cloudflare returned partial data, so this instance cannot be classified as missing.'
        : 'No Cloudflare row matched this recorded physical instance in the selected window.';
    } else if (candidates.length !== 1) {
      status = 'ambiguous_application';
      statusDetail = 'Multiple Cloudflare applications returned this physical instance ID.';
    } else if (
      !candidates[0]?.hasUsage ||
      (meter.providerInstanceId !== null && partialUsageInstanceIds.has(meter.providerInstanceId))
    ) {
      status = 'provider_partial';
      statusDetail = 'Cloudflare returned only part of the required provider data.';
    } else {
      matchedProvider = candidates[0] ?? null;
      const provisionedCapacities = [
        ...new Set(
          [...meter.services]
            .map(provisionedCapacityForService)
            .filter((value): value is ProvisionedCapacity => value !== null)
            .map(value => `${value.memoryBytes}:${value.diskBytes}`)
        ),
      ];
      const [memoryBytesValue, diskBytesValue] = provisionedCapacities[0]
        ?.split(':')
        .map(Number) ?? [undefined, undefined];
      if (
        provisionedCapacities.length !== 1 ||
        memoryBytesValue === undefined ||
        diskBytesValue === undefined
      ) {
        status = 'comparison_unavailable';
        statusDetail = 'The recorded service has no single verified provisioned-capacity mapping.';
      } else {
        provisionedMemoryBytes = memoryBytesValue;
        provisionedDiskBytes = diskBytesValue;
        providerMemorySeconds = matchedProvider.usage.allocatedMemory / memoryBytesValue;
        providerDiskSeconds = matchedProvider.usage.allocatedDisk / diskBytesValue;
        const capacityCrossCheckDifference = Math.abs(providerMemorySeconds - providerDiskSeconds);
        const capacityCrossCheckScale = Math.max(1, providerMemorySeconds, providerDiskSeconds);
        if (
          capacityCrossCheckDifference / capacityCrossCheckScale >
          CAPACITY_CROSS_CHECK_RELATIVE_TOLERANCE
        ) {
          status = 'comparison_unavailable';
          statusDetail =
            'Provider memory and disk byte-seconds imply different active durations for this service capacity.';
        } else {
          status = 'matched';
          statusDetail =
            'Provider memory and disk byte-seconds agree for the provisioned capacity.';
          providerComparisonSeconds = providerMemorySeconds;
          differenceSeconds = providerComparisonSeconds - meter.acceptedSeconds;
          differencePercent =
            meter.acceptedSeconds === 0 ? null : (differenceSeconds / meter.acceptedSeconds) * 100;
        }
      }
    }

    return {
      instanceId: meter.providerInstanceId ?? [...meter.meterInstanceIds].sort()[0] ?? 'unknown',
      providerInstanceId: meter.providerInstanceId,
      meterInstanceIds: [...meter.meterInstanceIds].sort(),
      services: [...meter.services].sort(),
      providerApplicationIds,
      skuIds: [...meter.skuIds].sort(),
      intervalCount: meter.intervalIds.size,
      meterAcceptedSeconds: meter.acceptedSeconds,
      providerComparisonSeconds,
      providerMemorySeconds,
      providerDiskSeconds,
      provisionedMemoryBytes,
      provisionedDiskBytes,
      differenceSeconds,
      differencePercent,
      providerCpuTimeSec: matchedProvider?.hasUsage ? matchedProvider.usage.cpuTimeSec : null,
      providerAllocatedMemoryByteSeconds: matchedProvider?.hasUsage
        ? matchedProvider.usage.allocatedMemory
        : null,
      providerAllocatedDiskByteSeconds: matchedProvider?.hasUsage
        ? matchedProvider.usage.allocatedDisk
        : null,
      providerTxBytes: matchedProvider?.hasUsage ? matchedProvider.usage.txBytes : null,
      status,
      statusDetail,
    };
  });
}

type UsageSummaryInput = z.infer<typeof usageSummarySchema>;
type QueryContainerUsageAnalytics = typeof queryContainerUsageAnalytics;

export async function reconcileUsageWithCloudflare(
  input: UsageSummaryInput,
  queryProvider: QueryContainerUsageAnalytics = queryContainerUsageAnalytics
) {
  const meterSegments = await db
    .select({
      intervalId: container_usage_interval.id,
      service: container_usage_interval.service,
      instanceId: container_usage_interval.instance_id,
      skuId: container_usage_interval.cloud_billing_sku_id,
      metadata: container_usage_interval.metadata,
      acceptedSeconds:
        sql<number>`coalesce(sum(${container_usage_segment.usage_seconds}), 0)`.mapWith(Number),
    })
    .from(container_usage_segment)
    .innerJoin(
      container_usage_interval,
      eq(container_usage_segment.interval_id, container_usage_interval.id)
    )
    .where(
      and(
        eq(container_usage_interval.subject_type, input.subjectType),
        eq(container_usage_interval.subject_id, input.subjectId),
        sql`${container_usage_segment.received_at} >= ${input.start}`,
        lt(container_usage_segment.received_at, input.end)
      )
    )
    .groupBy(
      container_usage_interval.id,
      container_usage_interval.service,
      container_usage_interval.instance_id,
      container_usage_interval.cloud_billing_sku_id,
      container_usage_interval.metadata
    );

  const grouped = new Map<string, MeterReconciliationRow>();
  for (const meterSegment of meterSegments) addMeterReconciliationRow(grouped, meterSegment);
  const meterRows = [...grouped.values()];
  const providerInstanceIds = [
    ...new Set(meterRows.flatMap(row => (row.providerInstanceId ? [row.providerInstanceId] : []))),
  ];
  if (providerInstanceIds.length > MAX_RECONCILIATION_INSTANCES) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `This window contains ${providerInstanceIds.length} unique Cloudflare instances (maximum ${MAX_RECONCILIATION_INSTANCES}). Narrow the window and retry.`,
    });
  }

  let provider: ContainerUsageAnalyticsResult | null = null;
  if (providerInstanceIds.length > 0) {
    try {
      provider = await queryProvider({
        instanceIds: providerInstanceIds,
        start: input.start,
        end: input.end,
      });
    } catch (error) {
      if (error instanceof ContainerUsageAnalyticsError) {
        throw new TRPCError({
          code: providerErrorCode(error),
          message: error.message,
          cause: error,
        });
      }
      throw error;
    }
  }

  const rows = normalizedReconciliationRows(meterRows, provider);
  const countStatus = (status: ReconciliationStatus) =>
    rows.filter(row => row.status === status).length;
  const matchedRows = rows.filter(row => row.status === 'matched');
  const completeComparison = rows.length > 0 && matchedRows.length === rows.length;
  const totalMeterSeconds = rows.reduce((total, row) => total + row.meterAcceptedSeconds, 0);
  const totalProviderSeconds = completeComparison
    ? matchedRows.reduce((total, row) => total + (row.providerComparisonSeconds ?? 0), 0)
    : null;
  const totalDifferenceSeconds =
    totalProviderSeconds === null ? null : totalProviderSeconds - totalMeterSeconds;
  return {
    subjectType: input.subjectType,
    subjectId: input.subjectId,
    start: input.start,
    end: input.end,
    generatedAt: new Date().toISOString(),
    comparison: {
      available: matchedRows.length > 0,
      method: 'allocated_memory_byte_seconds' as const,
      description: COMPARISON_METHOD,
    },
    totals: {
      meterAcceptedSeconds: totalMeterSeconds,
      providerComparisonSeconds: totalProviderSeconds,
      differenceSeconds: totalDifferenceSeconds,
      differencePercent:
        totalDifferenceSeconds === null || totalMeterSeconds === 0
          ? null
          : (totalDifferenceSeconds / totalMeterSeconds) * 100,
      providerCpuTimeSec: completeComparison
        ? matchedRows.reduce((total, row) => total + (row.providerCpuTimeSec ?? 0), 0)
        : null,
      intervalCount: new Set(meterSegments.map(row => row.intervalId)).size,
      uniqueMeterInstances: rows.length,
      queriedCloudflareInstances: providerInstanceIds.length,
    },
    counts: {
      matched: countStatus('matched'),
      missing: countStatus('missing_from_cloudflare'),
      ambiguous: countStatus('ambiguous_application'),
      partial: countStatus('provider_partial'),
      comparisonUnavailable: countStatus('comparison_unavailable'),
    },
    provider: {
      requested: provider !== null,
      partial: provider?.partial ?? false,
      issues: provider?.issues ?? [],
      rawResponses: provider?.rawResponses ?? [],
    },
    rows,
  };
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
        eq(container_usage_interval.subject_id, input.search.subjectId),
        sql`exists (
          select 1 from ${container_usage_segment}
          where ${container_usage_segment.interval_id} = ${container_usage_interval.id}
            and ${container_usage_segment.received_at} >= ${input.search.start}
            and ${container_usage_segment.received_at} < ${input.search.end}
        )`
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

  getUsageSummary: adminProcedure.input(usageSummarySchema).query(async ({ input }) => {
    const rows = await db
      .select({
        skuId: container_usage_interval.cloud_billing_sku_id,
        skuName: cloud_billing_sku.name,
        rateCentsPerSecond: cloud_billing_sku.rate_cents_per_unit,
        acceptedSeconds:
          sql<number>`coalesce(sum(${container_usage_segment.usage_seconds}), 0)`.mapWith(Number),
        intervals: sql<number>`count(distinct ${container_usage_interval.id})`.mapWith(Number),
        estimatedCents:
          sql<string>`coalesce(sum(${container_usage_segment.usage_seconds}::numeric * ${cloud_billing_sku.rate_cents_per_unit}), 0)::text`.mapWith(
            String
          ),
        totalAcceptedSeconds:
          sql<number>`sum(sum(${container_usage_segment.usage_seconds})) over ()`.mapWith(Number),
        totalEstimatedCents:
          sql<string>`sum(sum(${container_usage_segment.usage_seconds}::numeric * ${cloud_billing_sku.rate_cents_per_unit})) over ()::text`.mapWith(
            String
          ),
      })
      .from(container_usage_segment)
      .innerJoin(
        container_usage_interval,
        eq(container_usage_segment.interval_id, container_usage_interval.id)
      )
      .innerJoin(
        cloud_billing_sku,
        eq(container_usage_interval.cloud_billing_sku_id, cloud_billing_sku.id)
      )
      .where(
        and(
          eq(container_usage_interval.subject_type, input.subjectType),
          eq(container_usage_interval.subject_id, input.subjectId),
          sql`${container_usage_segment.received_at} >= ${input.start}`,
          lt(container_usage_segment.received_at, input.end)
        )
      )
      .groupBy(
        container_usage_interval.cloud_billing_sku_id,
        cloud_billing_sku.name,
        cloud_billing_sku.rate_cents_per_unit
      )
      .orderBy(container_usage_interval.cloud_billing_sku_id);
    const items = rows.map(row => ({
      skuId: row.skuId,
      skuName: row.skuName,
      rateCentsPerSecond: normalizeCloudBillingSkuRate(row.rateCentsPerSecond),
      acceptedSeconds: row.acceptedSeconds,
      estimatedCents: normalizeCloudBillingSkuRate(row.estimatedCents),
      intervals: row.intervals,
    }));
    const totals = rows[0];
    return {
      subjectType: input.subjectType,
      subjectId: input.subjectId,
      start: input.start,
      end: input.end,
      items,
      acceptedSeconds: totals?.totalAcceptedSeconds ?? 0,
      estimatedCents: normalizeCloudBillingSkuRate(totals?.totalEstimatedCents ?? '0'),
    };
  }),

  reconcileUsageWithCloudflare: adminProcedure
    .input(usageSummarySchema)
    .mutation(async ({ input }) => reconcileUsageWithCloudflare(input)),

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
