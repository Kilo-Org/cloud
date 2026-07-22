import { beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
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
  serializeCloudBillingSku,
  serializeUsageInterval,
  serializeUsageSegment,
} from './cloud-billing-skus-router';

let admin: User;
let nonAdmin: User;

beforeEach(async () => {
  await cleanupDbForTest();
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
}) {
  const subjectType = params.subjectType ?? 'user';
  const subjectId = params.subjectId ?? admin.id;
  await db.insert(container_usage_interval).values({
    id: params.id,
    service: 'cloud-agent-next',
    instance_id: params.id,
    start_epoch_ms: 123,
    cloud_billing_sku_id: 'usage-search-sku',
    context_fingerprint: 'a'.repeat(64),
    subject_type: subjectType,
    subject_id: subjectId,
    actor_type: 'user',
    actor_id: subjectType === 'user' ? subjectId : admin.id,
    started_at: params.startedAt ?? '2026-07-22T10:00:00.000Z',
    last_seen_at: params.startedAt ?? '2026-07-22T10:00:00.000Z',
  });
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
    const caller = await createCallerForUser(admin.id);
    const first = await caller.admin.cloudBillingSkus.searchUsageIntervals({
      search: { kind: 'subject', subjectType: 'user', subjectId: 'subject-1' },
      limit: 1,
    });
    expect(first.items.map(item => item.id)).toEqual(['interval-b']);
    expect(first.nextCursor).not.toBeNull();
    if (!first.nextCursor) throw new Error('Expected an interval cursor');
    const second = await caller.admin.cloudBillingSkus.searchUsageIntervals({
      search: { kind: 'subject', subjectType: 'user', subjectId: 'subject-1' },
      limit: 1,
      cursor: first.nextCursor,
    });
    expect(second.items.map(item => item.id)).toEqual(['interval-a']);
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
