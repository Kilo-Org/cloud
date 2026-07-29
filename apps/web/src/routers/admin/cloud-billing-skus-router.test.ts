import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import type { ContainerUsageAnalyticsResult } from '@/lib/cloudflare/container-usage-analytics';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  cloud_billing_sku,
  container_usage_interval,
  container_usage_segment,
  type User,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  reconcileUsageWithCloudflare,
  serializeCloudBillingSku,
  serializeUsageInterval,
  serializeUsageSegment,
} from './cloud-billing-skus-router';

const mockQueryContainerUsageAnalytics =
  jest.fn<
    (input: {
      instanceIds: string[];
      start: string;
      end: string;
    }) => Promise<ContainerUsageAnalyticsResult>
  >();

let admin: User;
let nonAdmin: User;

beforeEach(async () => {
  await cleanupDbForTest();
  mockQueryContainerUsageAnalytics.mockReset();
  [admin, nonAdmin] = await Promise.all([insertTestUser({ is_admin: true }), insertTestUser()]);
});

function validInput(id: string) {
  return {
    id,
    name: 'Cloud Agent Standard',
    description: 'Container awake time',
    unit: 'second' as const,
    rate_cents_per_unit: '0.123456789012',
  };
}

async function insertUsageInterval(params: {
  id: string;
  subjectType?: 'user' | 'org';
  subjectId?: string;
  startedAt?: string;
  service?: string;
  instanceId?: string;
  skuId?: string;
  metadata?: Record<string, string>;
}) {
  const subjectType = params.subjectType ?? 'user';
  const subjectId = params.subjectId ?? admin.id;
  await db.insert(container_usage_interval).values({
    id: params.id,
    service: params.service ?? 'cloud-agent-next',
    instance_id: params.instanceId ?? params.id,
    start_epoch_ms: 123,
    cloud_billing_sku_id: params.skuId ?? 'usage-search-sku',
    context_fingerprint: 'a'.repeat(64),
    subject_type: subjectType,
    subject_id: subjectId,
    actor_type: 'user',
    actor_id: subjectType === 'user' ? subjectId : admin.id,
    started_at: params.startedAt ?? '2026-07-22T10:00:00.000Z',
    last_seen_at: params.startedAt ?? '2026-07-22T10:00:00.000Z',
    metadata: params.metadata,
  });
}

function providerSettings() {
  return {
    enabled: true,
    availableFields: [],
    maxPageSize: 100,
    maxNumberOfFields: 30,
    notOlderThan: 2_678_400,
    maxDuration: 86_400,
  };
}

function providerResult(
  rows: ContainerUsageAnalyticsResult['rows'],
  options: { partial?: boolean; issues?: string[]; usagePartialInstanceIds?: string[] } = {}
) {
  return {
    rows,
    partial: options.partial ?? false,
    usagePartialInstanceIds: options.usagePartialInstanceIds ?? [],
    issues: options.issues ?? [],
    settings: {
      containersUsageAdaptiveGroups: providerSettings(),
    },
    rawResponses: [
      {
        dataset: 'containersUsageAdaptiveGroups' as const,
        windowIndex: 0,
        batchIndex: 0,
        window: {
          start: '2026-07-22T09:00:00.000Z',
          end: '2026-07-22T11:00:00.000Z',
        },
        body: { data: { viewer: { accounts: [] } }, errors: null },
      },
    ],
  };
}

describe('admin.cloudBillingSkus.list', () => {
  it('allows admins to list SKUs and rejects non-admins', async () => {
    await db.insert(cloud_billing_sku).values({
      ...validInput('cloud-agent-standard'),
      created_by_user_id: admin.id,
    });

    const adminCaller = await createCallerForUser(admin.id);
    await expect(adminCaller.admin.cloudBillingSkus.list()).resolves.toEqual([
      expect.objectContaining({
        id: 'cloud-agent-standard',
        accepts_new_usage: true,
      }),
    ]);

    const nonAdminCaller = await createCallerForUser(nonAdmin.id);
    await expect(nonAdminCaller.admin.cloudBillingSkus.list()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('normalizes production-shaped PostgreSQL timestamps to UTC ISO', () => {
    const serialized = serializeCloudBillingSku({
      id: 'timestamp-sku',
      name: 'Timestamp SKU',
      description: null,
      unit: 'second',
      rate_cents_per_unit: '0.1',
      accepts_new_usage: true,
      created_by_user_id: null,
      created_at: '2026-04-29 01:16:12.945+00',
    });

    expect(serialized.created_at).toBe('2026-04-29T01:16:12.945Z');
  });
});

describe('admin.cloudBillingSkus usage records', () => {
  beforeEach(async () => {
    await db.insert(cloud_billing_sku).values({
      ...validInput('usage-search-sku'),
      created_by_user_id: admin.id,
    });
  });

  it('merges the most recently active open and closed intervals', async () => {
    const now = Date.now();
    const openAt = new Date(now - 2 * 60_000).toISOString();
    const closedAt = new Date(now - 60_000).toISOString();
    const oldAt = new Date(now - 25 * 60 * 60_000).toISOString();
    await insertUsageInterval({ id: 'recent-open', startedAt: openAt });
    await insertUsageInterval({ id: 'recent-closed', startedAt: closedAt });
    await insertUsageInterval({ id: 'recent-old', startedAt: oldAt });
    await db
      .update(container_usage_interval)
      .set({
        status: 'closed',
        close_reason: 'exit',
        stopped_at: closedAt,
        last_seen_at: closedAt,
      })
      .where(eq(container_usage_interval.id, 'recent-closed'));
    await db
      .update(container_usage_interval)
      .set({ status: 'closed', close_reason: 'unconfirmed', stopped_at: oldAt })
      .where(eq(container_usage_interval.id, 'recent-old'));
    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.cloudBillingSkus.searchUsageIntervals({
      search: { kind: 'recent' },
      limit: 10,
    });
    expect(result.items.map(item => item.id)).toEqual([
      'recent-closed',
      'recent-open',
      'recent-old',
    ]);
    const bounded = await caller.admin.cloudBillingSkus.searchUsageIntervals({
      search: { kind: 'recent' },
      closeReason: 'unconfirmed',
      limit: 10,
    });
    expect(bounded.items).toEqual([]);
  });

  it('normalizes production-shaped interval and segment timestamps', () => {
    const interval = serializeUsageInterval({
      id: 'timestamp-interval',
      service: 'cloud-agent-next',
      instance_id: 'instance-1',
      start_epoch_ms: 123,
      cloud_billing_sku_id: 'usage-search-sku',
      context_fingerprint: 'a'.repeat(64),
      subject_type: 'user',
      subject_id: 'user-1',
      actor_type: 'user',
      actor_id: 'user-1',
      session_id: null,
      started_at: '2026-04-29 01:16:12.945+00',
      last_seen_at: '2026-04-29 01:17:12.945+00',
      last_heartbeat_seq: 1,
      confirmed_seconds: 60,
      stopped_at: '2026-04-29 01:17:12.945+00',
      close_reason: 'exit',
      exit_code: 0,
      final_stop_seq: 1,
      status: 'closed',
      metadata: null,
    });
    const segment = serializeUsageSegment({
      interval_id: interval.id,
      seq: 1,
      idempotency_key: 'hidden',
      reported_seconds: 60,
      usage_seconds: 60,
      received_at: '2026-04-29 01:17:12.945+00',
    });
    expect(interval).toMatchObject({
      started_at: '2026-04-29T01:16:12.945Z',
      last_seen_at: '2026-04-29T01:17:12.945Z',
      stopped_at: '2026-04-29T01:17:12.945Z',
    });
    expect(segment.received_at).toBe('2026-04-29T01:17:12.945Z');
  });

  it('requires admin access and searches exact interval IDs', async () => {
    await insertUsageInterval({ id: 'interval-exact' });
    const nonAdminCaller = await createCallerForUser(nonAdmin.id);
    await expect(
      nonAdminCaller.admin.cloudBillingSkus.searchUsageIntervals({
        search: { kind: 'interval', id: 'interval-exact' },
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.cloudBillingSkus.searchUsageIntervals({
      search: { kind: 'interval', id: 'interval-exact' },
    });
    expect(result.items).toEqual([
      expect.objectContaining({
        id: 'interval-exact',
        started_at: '2026-07-22T10:00:00.000Z',
      }),
    ]);
    expect(result.items[0]).not.toHaveProperty('context_fingerprint');
    expect(result.items[0]).not.toHaveProperty('metadata');
    expect(result.items[0]).not.toHaveProperty('session_id');
  });

  it('pages exact subject history deterministically', async () => {
    await insertUsageInterval({ id: 'interval-b', subjectId: 'subject-1' });
    await insertUsageInterval({ id: 'interval-a', subjectId: 'subject-1' });
    await insertUsageInterval({ id: 'interval-other', subjectId: 'subject-2' });
    await db.insert(container_usage_segment).values([
      {
        interval_id: 'interval-b',
        seq: 1,
        idempotency_key: 'interval-b-segment',
        reported_seconds: 1,
        usage_seconds: 1,
        received_at: '2026-07-22T10:01:00.000Z',
      },
      {
        interval_id: 'interval-a',
        seq: 1,
        idempotency_key: 'interval-a-segment',
        reported_seconds: 1,
        usage_seconds: 1,
        received_at: '2026-07-22T10:01:00.000Z',
      },
      {
        interval_id: 'interval-other',
        seq: 1,
        idempotency_key: 'interval-other-segment',
        reported_seconds: 1,
        usage_seconds: 1,
        received_at: '2026-07-22T10:01:00.000Z',
      },
    ]);
    const caller = await createCallerForUser(admin.id);
    const first = await caller.admin.cloudBillingSkus.searchUsageIntervals({
      search: {
        kind: 'subject',
        subjectType: 'user',
        subjectId: 'subject-1',
        start: '2026-07-22T09:00:00.000Z',
        end: '2026-07-22T11:00:00.000Z',
      },
      limit: 1,
    });
    expect(first.items.map(item => item.id)).toEqual(['interval-b']);
    expect(first.nextCursor).not.toBeNull();
    if (!first.nextCursor) throw new Error('Expected an interval cursor');
    const second = await caller.admin.cloudBillingSkus.searchUsageIntervals({
      search: {
        kind: 'subject',
        subjectType: 'user',
        subjectId: 'subject-1',
        start: '2026-07-22T09:00:00.000Z',
        end: '2026-07-22T11:00:00.000Z',
      },
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map(item => item.id)).toEqual(['interval-a']);
  });

  it('summarizes only an exact subject and bounded activity window by SKU', async () => {
    await db.insert(cloud_billing_sku).values({
      ...validInput('usage-summary-sku'),
      rate_cents_per_unit: '0.125',
      created_by_user_id: admin.id,
    });
    await insertUsageInterval({
      id: 'summary-in-window',
      subjectId: 'summary-subject',
      startedAt: '2026-07-22T10:00:00.000Z',
    });
    await db
      .update(container_usage_interval)
      .set({ cloud_billing_sku_id: 'usage-summary-sku', confirmed_seconds: 999 })
      .where(eq(container_usage_interval.id, 'summary-in-window'));
    await db.insert(container_usage_segment).values([
      {
        interval_id: 'summary-in-window',
        seq: 1,
        idempotency_key: 'summary-start-boundary',
        reported_seconds: 12,
        usage_seconds: 12,
        received_at: '2026-07-22T09:00:00.000Z',
      },
      {
        interval_id: 'summary-in-window',
        seq: 2,
        idempotency_key: 'summary-end-boundary',
        reported_seconds: 100,
        usage_seconds: 100,
        received_at: '2026-07-22T11:00:00.000Z',
      },
    ]);
    await insertUsageInterval({
      id: 'summary-other-subject',
      subjectId: 'other-subject',
      startedAt: '2026-07-22T10:00:00.000Z',
    });
    await db
      .update(container_usage_interval)
      .set({ confirmed_seconds: 999 })
      .where(eq(container_usage_interval.id, 'summary-other-subject'));
    await db.insert(container_usage_segment).values({
      interval_id: 'summary-other-subject',
      seq: 1,
      idempotency_key: 'summary-other-subject',
      reported_seconds: 999,
      usage_seconds: 999,
      received_at: '2026-07-22T10:00:00.000Z',
    });
    await insertUsageInterval({
      id: 'summary-outside-window',
      subjectId: 'summary-subject',
      startedAt: '2026-07-23T10:00:00.000Z',
    });
    await db
      .update(container_usage_interval)
      .set({ confirmed_seconds: 999 })
      .where(eq(container_usage_interval.id, 'summary-outside-window'));
    await db.insert(container_usage_segment).values({
      interval_id: 'summary-outside-window',
      seq: 1,
      idempotency_key: 'summary-outside-window',
      reported_seconds: 999,
      usage_seconds: 999,
      received_at: '2026-07-23T10:00:00.000Z',
    });

    const caller = await createCallerForUser(admin.id);
    const summary = await caller.admin.cloudBillingSkus.getUsageSummary({
      subjectType: 'user',
      subjectId: 'summary-subject',
      start: '2026-07-22T09:00:00.000Z',
      end: '2026-07-22T11:00:00.000Z',
    });

    expect(summary).toMatchObject({
      acceptedSeconds: 12,
      estimatedCents: '1.5',
      items: [
        {
          skuId: 'usage-summary-sku',
          acceptedSeconds: 12,
          estimatedCents: '1.5',
          intervals: 1,
        },
      ],
    });

    const nonAdminCaller = await createCallerForUser(nonAdmin.id);
    await expect(
      nonAdminCaller.admin.cloudBillingSkus.getUsageSummary({
        subjectType: 'user',
        subjectId: 'summary-subject',
        start: '2026-07-22T09:00:00.000Z',
        end: '2026-07-22T11:00:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects invalid and oversized usage summary windows', async () => {
    const caller = await createCallerForUser(admin.id);
    await expect(
      caller.admin.cloudBillingSkus.getUsageSummary({
        subjectType: 'user',
        subjectId: 'summary-subject',
        start: '2026-07-22T11:00:00.000Z',
        end: '2026-07-22T10:00:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      caller.admin.cloudBillingSkus.getUsageSummary({
        subjectType: 'user',
        subjectId: 'summary-subject',
        start: '2026-06-01T00:00:00.000Z',
        end: '2026-07-03T00:00:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('reconciles only exact subject activity, resolves provider identities, and deduplicates generations', async () => {
    await db.insert(cloud_billing_sku).values({
      ...validInput('usage-reconciliation-sku'),
      created_by_user_id: admin.id,
    });
    await insertUsageInterval({
      id: 'cloud-generation-1',
      subjectId: 'reconcile-subject',
      service: 'cloud-agent-next-sandbox',
      instanceId: 'sandbox-name',
      metadata: { durable_object_id: 'cloud-physical-id' },
    });
    await db
      .update(container_usage_interval)
      .set({
        status: 'closed',
        close_reason: 'exit',
        stopped_at: '2026-07-22T10:30:00.000Z',
        last_seen_at: '2026-07-22T10:30:00.000Z',
      })
      .where(eq(container_usage_interval.id, 'cloud-generation-1'));
    await insertUsageInterval({
      id: 'cloud-generation-2',
      subjectId: 'reconcile-subject',
      service: 'cloud-agent-next-sandbox',
      instanceId: 'sandbox-name',
      skuId: 'usage-reconciliation-sku',
      metadata: { durable_object_id: 'cloud-physical-id' },
    });
    await insertUsageInterval({
      id: 'gastown-generation',
      subjectType: 'org',
      subjectId: 'reconcile-org',
      service: 'gastown',
      instanceId: 'gastown-physical-id',
    });
    await insertUsageInterval({
      id: 'other-subject-generation',
      subjectId: 'other-subject',
      service: 'gastown',
      instanceId: 'unrelated-physical-id',
    });
    await db.insert(container_usage_segment).values([
      {
        interval_id: 'cloud-generation-1',
        seq: 1,
        idempotency_key: 'cloud-generation-1-start',
        reported_seconds: 10,
        usage_seconds: 10,
        received_at: '2026-07-22T09:00:00.000Z',
      },
      {
        interval_id: 'cloud-generation-2',
        seq: 1,
        idempotency_key: 'cloud-generation-2-middle',
        reported_seconds: 20,
        usage_seconds: 20,
        received_at: '2026-07-22T10:00:00.000Z',
      },
      {
        interval_id: 'cloud-generation-2',
        seq: 2,
        idempotency_key: 'cloud-generation-2-end',
        reported_seconds: 200,
        usage_seconds: 200,
        received_at: '2026-07-22T11:00:00.000Z',
      },
      {
        interval_id: 'gastown-generation',
        seq: 1,
        idempotency_key: 'gastown-middle',
        reported_seconds: 30,
        usage_seconds: 30,
        received_at: '2026-07-22T10:00:00.000Z',
      },
      {
        interval_id: 'other-subject-generation',
        seq: 1,
        idempotency_key: 'unrelated-middle',
        reported_seconds: 999,
        usage_seconds: 999,
        received_at: '2026-07-22T10:00:00.000Z',
      },
    ]);
    mockQueryContainerUsageAnalytics.mockImplementation(async input =>
      providerResult(
        input.instanceIds.map(instanceId => ({
          applicationId:
            instanceId === 'cloud-physical-id' ? 'observed-cloud-app' : 'observed-gastown-app',
          instanceId,
          usage: {
            cpuTimeSec: instanceId === 'cloud-physical-id' ? 3 : 4,
            allocatedMemory: 12 * 1024 ** 3 * 30,
            allocatedDisk: 20_000_000_000 * 30,
            txBytes: 3_000,
          },
        }))
      )
    );

    const userResult = await reconcileUsageWithCloudflare(
      {
        subjectType: 'user',
        subjectId: 'reconcile-subject',
        start: '2026-07-22T09:00:00.000Z',
        end: '2026-07-22T11:00:00.000Z',
      },
      mockQueryContainerUsageAnalytics
    );
    expect(mockQueryContainerUsageAnalytics).toHaveBeenLastCalledWith({
      instanceIds: ['cloud-physical-id'],
      start: '2026-07-22T09:00:00.000Z',
      end: '2026-07-22T11:00:00.000Z',
    });
    expect(userResult.totals).toMatchObject({
      meterAcceptedSeconds: 30,
      intervalCount: 2,
      uniqueMeterInstances: 1,
      queriedCloudflareInstances: 1,
      providerComparisonSeconds: 30,
      differenceSeconds: 0,
      differencePercent: 0,
    });
    expect(userResult.rows).toEqual([
      expect.objectContaining({
        providerInstanceId: 'cloud-physical-id',
        meterAcceptedSeconds: 30,
        intervalCount: 2,
        services: ['cloud-agent-next-sandbox'],
        skuIds: ['usage-reconciliation-sku', 'usage-search-sku'],
        providerCpuTimeSec: 3,
        providerComparisonSeconds: 30,
        providerMemorySeconds: 30,
        providerDiskSeconds: 30,
        provisionedMemoryBytes: 12 * 1024 ** 3,
        provisionedDiskBytes: 20_000_000_000,
        differenceSeconds: 0,
        differencePercent: 0,
        status: 'matched',
      }),
    ]);
    expect(userResult.provider.rawResponses).toHaveLength(1);

    const orgResult = await reconcileUsageWithCloudflare(
      {
        subjectType: 'org',
        subjectId: 'reconcile-org',
        start: '2026-07-22T09:00:00.000Z',
        end: '2026-07-22T11:00:00.000Z',
      },
      mockQueryContainerUsageAnalytics
    );
    expect(mockQueryContainerUsageAnalytics).toHaveBeenLastCalledWith({
      instanceIds: ['gastown-physical-id'],
      start: '2026-07-22T09:00:00.000Z',
      end: '2026-07-22T11:00:00.000Z',
    });
    expect(orgResult.rows[0]).toMatchObject({
      providerInstanceId: 'gastown-physical-id',
      providerApplicationIds: ['observed-gastown-app'],
      meterAcceptedSeconds: 30,
      providerComparisonSeconds: 30,
      status: 'matched',
    });
  });

  it('keeps missing, ambiguous, partial, and unresolved provider data explicit', async () => {
    await Promise.all([
      insertUsageInterval({
        id: 'missing-provider',
        subjectId: 'status-subject',
        service: 'gastown',
        instanceId: 'missing-id',
      }),
      insertUsageInterval({
        id: 'ambiguous-provider',
        subjectId: 'status-subject',
        service: 'gastown',
        instanceId: 'ambiguous-id',
      }),
      insertUsageInterval({
        id: 'partial-provider',
        subjectId: 'status-subject',
        service: 'gastown',
        instanceId: 'partial-id',
      }),
      insertUsageInterval({
        id: 'cloud-without-provider-id',
        subjectId: 'status-subject',
        service: 'cloud-agent-next-sandbox',
        instanceId: 'sandbox-without-metadata',
      }),
    ]);
    await db.insert(container_usage_segment).values(
      [
        'missing-provider',
        'ambiguous-provider',
        'partial-provider',
        'cloud-without-provider-id',
      ].map((intervalId, index) => ({
        interval_id: intervalId,
        seq: 1,
        idempotency_key: `status-${index}`,
        reported_seconds: 5,
        usage_seconds: 5,
        received_at: '2026-07-22T10:00:00.000Z',
      }))
    );
    mockQueryContainerUsageAnalytics.mockResolvedValue(
      providerResult(
        [
          {
            applicationId: 'app-gastown',
            instanceId: 'ambiguous-id',
            usage: { cpuTimeSec: 1, allocatedMemory: 2, allocatedDisk: 3, txBytes: 4 },
          },
          {
            applicationId: 'app-other',
            instanceId: 'ambiguous-id',
            usage: { cpuTimeSec: 10, allocatedMemory: 20, allocatedDisk: 30, txBytes: 40 },
          },
          {
            applicationId: 'app-gastown',
            instanceId: 'partial-id',
            usage: { cpuTimeSec: 0, allocatedMemory: 0, allocatedDisk: 0, txBytes: 0 },
          },
        ],
        {
          partial: true,
          issues: ['Provider usage response was partial.'],
          usagePartialInstanceIds: ['partial-id'],
        }
      )
    );

    const result = await reconcileUsageWithCloudflare(
      {
        subjectType: 'user',
        subjectId: 'status-subject',
        start: '2026-07-22T09:00:00.000Z',
        end: '2026-07-22T11:00:00.000Z',
      },
      mockQueryContainerUsageAnalytics
    );
    expect(mockQueryContainerUsageAnalytics).toHaveBeenCalledWith({
      instanceIds: expect.arrayContaining(['missing-id', 'ambiguous-id', 'partial-id']),
      start: '2026-07-22T09:00:00.000Z',
      end: '2026-07-22T11:00:00.000Z',
    });
    expect(mockQueryContainerUsageAnalytics.mock.calls[0]?.[0].instanceIds).toHaveLength(3);
    expect(result.counts).toEqual({
      matched: 0,
      missing: 1,
      ambiguous: 1,
      partial: 1,
      comparisonUnavailable: 1,
    });
    expect(result.rows.find(row => row.instanceId === 'missing-id')).toMatchObject({
      status: 'missing_from_cloudflare',
      providerCpuTimeSec: null,
    });
    expect(result.rows.find(row => row.instanceId === 'ambiguous-id')).toMatchObject({
      status: 'ambiguous_application',
      providerCpuTimeSec: null,
      providerApplicationIds: ['app-gastown', 'app-other'],
    });
    expect(result.rows.find(row => row.instanceId === 'partial-id')).toMatchObject({
      status: 'provider_partial',
      providerCpuTimeSec: null,
    });
    expect(result.rows.find(row => row.instanceId === 'sandbox-without-metadata')).toMatchObject({
      status: 'comparison_unavailable',
      providerInstanceId: null,
    });
  });

  it('does not call Cloudflare for empty meter usage and rejects non-admin reconciliation', async () => {
    const caller = await createCallerForUser(admin.id);
    const result = await caller.admin.cloudBillingSkus.reconcileUsageWithCloudflare({
      subjectType: 'user',
      subjectId: 'no-usage-subject',
      start: '2026-07-22T09:00:00.000Z',
      end: '2026-07-22T11:00:00.000Z',
    });
    expect(result.rows).toEqual([]);
    expect(result.provider).toEqual({
      requested: false,
      partial: false,
      issues: [],
      rawResponses: [],
    });
    expect(mockQueryContainerUsageAnalytics).not.toHaveBeenCalled();

    const nonAdminCaller = await createCallerForUser(nonAdmin.id);
    await expect(
      nonAdminCaller.admin.cloudBillingSkus.reconcileUsageWithCloudflare({
        subjectType: 'user',
        subjectId: 'no-usage-subject',
        start: '2026-07-22T09:00:00.000Z',
        end: '2026-07-22T11:00:00.000Z',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('does not normalize provider seconds when memory and disk durations disagree', async () => {
    await insertUsageInterval({
      id: 'capacity-mismatch',
      subjectId: 'capacity-subject',
      service: 'gastown',
      instanceId: 'capacity-instance',
    });
    await db.insert(container_usage_segment).values({
      interval_id: 'capacity-mismatch',
      seq: 1,
      idempotency_key: 'capacity-mismatch-segment',
      reported_seconds: 10,
      usage_seconds: 10,
      received_at: '2026-07-22T10:00:00.000Z',
    });
    mockQueryContainerUsageAnalytics.mockResolvedValue(
      providerResult([
        {
          applicationId: 'app-gastown',
          instanceId: 'capacity-instance',
          usage: {
            cpuTimeSec: 1,
            allocatedMemory: 12 * 1024 ** 3 * 10,
            allocatedDisk: 20_000_000_000 * 11,
            txBytes: 0,
          },
        },
      ])
    );

    const result = await reconcileUsageWithCloudflare(
      {
        subjectType: 'user',
        subjectId: 'capacity-subject',
        start: '2026-07-22T09:00:00.000Z',
        end: '2026-07-22T11:00:00.000Z',
      },
      mockQueryContainerUsageAnalytics
    );

    expect(result.rows[0]).toMatchObject({
      providerMemorySeconds: 10,
      providerDiskSeconds: 11,
      providerComparisonSeconds: null,
      differenceSeconds: null,
      status: 'comparison_unavailable',
    });
    expect(result.totals.providerComparisonSeconds).toBeNull();
  });

  it('rejects reconciliation above the unique physical instance cap', async () => {
    const intervalIds = Array.from({ length: 101 }, (_, index) => `capped-instance-${index}`);
    await db.insert(container_usage_interval).values(
      intervalIds.map((id, index) => ({
        id,
        service: 'gastown',
        instance_id: `physical-${index}`,
        start_epoch_ms: index + 1,
        cloud_billing_sku_id: 'usage-search-sku',
        context_fingerprint: 'a'.repeat(64),
        subject_type: 'user' as const,
        subject_id: 'capped-subject',
        actor_type: 'user' as const,
        actor_id: 'capped-subject',
        started_at: '2026-07-22T10:00:00.000Z',
        last_seen_at: '2026-07-22T10:00:00.000Z',
      }))
    );
    await db.insert(container_usage_segment).values(
      intervalIds.map((intervalId, index) => ({
        interval_id: intervalId,
        seq: 1,
        idempotency_key: `capped-segment-${index}`,
        reported_seconds: 1,
        usage_seconds: 1,
        received_at: '2026-07-22T10:00:00.000Z',
      }))
    );

    await expect(
      reconcileUsageWithCloudflare(
        {
          subjectType: 'user',
          subjectId: 'capped-subject',
          start: '2026-07-22T09:00:00.000Z',
          end: '2026-07-22T11:00:00.000Z',
        },
        mockQueryContainerUsageAnalytics
      )
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('maximum 100'),
    });
    expect(mockQueryContainerUsageAnalytics).not.toHaveBeenCalled();
  });

  it('returns ordered, safe segment details and rejects unknown intervals', async () => {
    await insertUsageInterval({ id: 'interval-segments' });
    await db
      .update(container_usage_interval)
      .set({ metadata: { repository: 'Kilo-Org/cloud', runtime: 'container' } })
      .where(eq(container_usage_interval.id, 'interval-segments'));
    await db.insert(container_usage_segment).values([
      {
        interval_id: 'interval-segments',
        seq: 2,
        idempotency_key: 'segment-2',
        reported_seconds: 10,
        usage_seconds: 8,
        received_at: '2026-07-22T10:02:00.000Z',
      },
      {
        interval_id: 'interval-segments',
        seq: 1,
        idempotency_key: 'segment-1',
        reported_seconds: 5,
        usage_seconds: 5,
        received_at: '2026-07-22T10:01:00.000Z',
      },
    ]);
    const caller = await createCallerForUser(admin.id);
    const first = await caller.admin.cloudBillingSkus.listUsageSegments({
      intervalId: 'interval-segments',
      limit: 1,
    });
    expect(first.items.map(item => item.seq)).toEqual([1]);
    expect(first.nextCursor).toBe(1);
    expect(first.metadata).toEqual({ repository: 'Kilo-Org/cloud', runtime: 'container' });
    if (!first.nextCursor) throw new Error('Expected a segment cursor');
    const result = await caller.admin.cloudBillingSkus.listUsageSegments({
      intervalId: 'interval-segments',
      afterSeq: first.nextCursor,
      limit: 1,
    });
    expect(result.items.map(item => item.seq)).toEqual([2]);
    expect(result.nextCursor).toBeNull();
    expect(result.items[0]).toMatchObject({
      reported_seconds: 10,
      usage_seconds: 8,
      received_at: '2026-07-22T10:02:00.000Z',
    });
    expect(result.items[0]).not.toHaveProperty('idempotency_key');
    expect(result).not.toHaveProperty('context_fingerprint');
    await db
      .update(container_usage_interval)
      .set({ metadata: { invalid: { nested: true } } as never })
      .where(eq(container_usage_interval.id, 'interval-segments'));
    await expect(
      caller.admin.cloudBillingSkus.listUsageSegments({ intervalId: 'interval-segments' })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Stored usage metadata is invalid',
    });
    const nonAdminCaller = await createCallerForUser(nonAdmin.id);
    await expect(
      nonAdminCaller.admin.cloudBillingSkus.listUsageSegments({
        intervalId: 'interval-segments',
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.admin.cloudBillingSkus.listUsageSegments({ intervalId: 'missing' })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('reports bounded accounting health metrics and requires admin access', async () => {
    const now = Date.now();
    const recent = new Date(now - 60_000).toISOString();
    const stale = new Date(now - 20 * 60_000).toISOString();
    await insertUsageInterval({ id: 'health-open', startedAt: stale });
    await insertUsageInterval({ id: 'health-closed', startedAt: recent });
    await db
      .update(container_usage_interval)
      .set({ status: 'closed', close_reason: 'unconfirmed', stopped_at: recent })
      .where(eq(container_usage_interval.id, 'health-closed'));
    await db.insert(container_usage_segment).values({
      interval_id: 'health-closed',
      seq: 1,
      idempotency_key: 'health-segment',
      reported_seconds: 10,
      usage_seconds: 8,
      received_at: recent,
    });

    const caller = await createCallerForUser(admin.id);
    const health = await caller.admin.cloudBillingSkus.usageHealth();
    expect(health).toMatchObject({
      intervalsReported: 1,
      openIntervals: 1,
      staleOpenIntervals: 1,
      closedIntervalsWithRecentActivity: 1,
      unconfirmedIntervalsWithRecentActivity: 1,
      segments: 1,
      reportedSeconds: 10,
      acceptedSeconds: 8,
      clippedSeconds: 2,
      clippedSegments: 1,
      closeReasonsByLastActivity: [{ reason: 'unconfirmed', count: 1 }],
    });
    expect(health.generatedAt).toMatch(/Z$/);
    const unconfirmed = await caller.admin.cloudBillingSkus.searchUsageIntervals({
      search: { kind: 'recent' },
      closeReason: 'unconfirmed',
      limit: 10,
    });
    expect(unconfirmed.items.map(item => item.id)).toEqual(['health-closed']);
    const nonAdminCaller = await createCallerForUser(nonAdmin.id);
    await expect(nonAdminCaller.admin.cloudBillingSkus.usageHealth()).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});

describe('admin.cloudBillingSkus.create', () => {
  it('requires admin access', async () => {
    const caller = await createCallerForUser(nonAdmin.id);

    await expect(
      caller.admin.cloudBillingSkus.create(validInput('restricted-sku'))
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const rows = await db.select().from(cloud_billing_sku);
    expect(rows).toHaveLength(0);
  });

  it('persists the exact rate and authenticated creator', async () => {
    const caller = await createCallerForUser(admin.id);

    await caller.admin.cloudBillingSkus.create(validInput('exact-rate-sku'));

    const [persisted] = await db
      .select()
      .from(cloud_billing_sku)
      .where(eq(cloud_billing_sku.id, 'exact-rate-sku'));
    expect(persisted).toMatchObject({
      id: 'exact-rate-sku',
      rate_cents_per_unit: '0.123456789012',
      created_by_user_id: admin.id,
      accepts_new_usage: true,
    });
  });

  it('returns a canonical rate after PostgreSQL scale padding', async () => {
    const caller = await createCallerForUser(admin.id);

    const created = await caller.admin.cloudBillingSkus.create({
      ...validInput('canonical-rate-sku'),
      rate_cents_per_unit: '1.2300',
    });
    const listed = await caller.admin.cloudBillingSkus.list();

    expect(created.rate_cents_per_unit).toBe('1.23');
    expect(listed.find(sku => sku.id === 'canonical-rate-sku')?.rate_cents_per_unit).toBe('1.23');
    const [persisted] = await db
      .select({ rate: cloud_billing_sku.rate_cents_per_unit })
      .from(cloud_billing_sku)
      .where(eq(cloud_billing_sku.id, 'canonical-rate-sku'));
    expect(persisted.rate).toBe('1.230000000000');
  });

  it('returns CONFLICT for a duplicate SKU ID', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.cloudBillingSkus.create(validInput('duplicate-sku'));

    await expect(
      caller.admin.cloudBillingSkus.create({
        ...validInput('duplicate-sku'),
        name: 'Replacement name',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('admin.cloudBillingSkus.disable', () => {
  it('requires admin access', async () => {
    await db.insert(cloud_billing_sku).values({
      ...validInput('protected-sku'),
      created_by_user_id: admin.id,
    });
    const caller = await createCallerForUser(nonAdmin.id);

    await expect(
      caller.admin.cloudBillingSkus.disable({ id: 'protected-sku' })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });

    const [persisted] = await db
      .select({ accepts_new_usage: cloud_billing_sku.accepts_new_usage })
      .from(cloud_billing_sku)
      .where(eq(cloud_billing_sku.id, 'protected-sku'));
    expect(persisted.accepts_new_usage).toBe(true);
  });

  it('only moves a SKU to disabled and remains disabled on repeated calls', async () => {
    const caller = await createCallerForUser(admin.id);
    await caller.admin.cloudBillingSkus.create(validInput('one-way-sku'));

    const disabled = await caller.admin.cloudBillingSkus.disable({ id: 'one-way-sku' });
    const disabledAgain = await caller.admin.cloudBillingSkus.disable({ id: 'one-way-sku' });

    expect(disabled.accepts_new_usage).toBe(false);
    expect(disabledAgain.accepts_new_usage).toBe(false);
    const [persisted] = await db
      .select({ accepts_new_usage: cloud_billing_sku.accepts_new_usage })
      .from(cloud_billing_sku)
      .where(eq(cloud_billing_sku.id, 'one-way-sku'));
    expect(persisted.accepts_new_usage).toBe(false);
  });
});
