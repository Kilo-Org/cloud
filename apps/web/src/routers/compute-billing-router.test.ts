import { describe, expect, it } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  cloud_billing_sku,
  compute_usage_charge,
  container_usage_interval,
  container_usage_segment,
  organization_memberships,
} from '@kilocode/db/schema';
import { CLOUD_AGENT_CONTAINER_SKUS } from '@kilocode/worker-utils/cloud-agent-compute';
import { computeBillingRouter } from './compute-billing-router';
import { formatComputePrice } from '@/lib/cloud-agent/compute-price';

const createCaller = createCallerFactory(computeBillingRouter);
const range = { startDate: '2026-10-01T00:00:00.000Z', endDate: '2026-11-01T00:00:00.000Z' };

async function fixture() {
  const owner = await insertTestUser();
  const member = await insertTestUser();
  const outsider = await insertTestUser();
  const org = await createTestOrganization('Compute billing', owner.id, 50_000_000);
  await db
    .insert(organization_memberships)
    .values({ organization_id: org.id, kilo_user_id: member.id, role: 'member' });
  const skuId = `compute-report-${crypto.randomUUID()}`;
  await db
    .insert(cloud_billing_sku)
    .values({ id: skuId, name: 'Medium compute', unit: 'second', rate_cents_per_unit: '0.01' });
  return { owner, member, outsider, org, skuId };
}

async function charge(input: {
  skuId: string;
  userId?: string;
  orgId?: string;
  actorId?: string;
  bot?: boolean;
  sessionId?: string;
  seconds?: number;
  day?: string;
  unlinked?: boolean;
}) {
  const id = crypto.randomUUID();
  const date = input.day ?? '2026-10-24T12:00:00.000Z';
  const seconds = input.seconds ?? 120;
  if (!input.unlinked) {
    await db.insert(container_usage_interval).values({
      id,
      service: 'cloud-agent-next-sandbox-containers-standard3',
      instance_id: id,
      start_epoch_ms: Date.parse(date),
      cloud_billing_sku_id: input.skuId,
      context_fingerprint: 'a'.repeat(64),
      subject_type: input.orgId ? 'org' : 'user',
      subject_id: input.orgId ?? input.userId!,
      actor_type: input.bot ? 'bot' : 'user',
      actor_id: input.bot ? 'webhook' : (input.actorId ?? input.userId!),
      session_id: input.sessionId,
      started_at: date,
      last_seen_at: date,
      metadata: input.bot ? { billingUserId: input.actorId! } : undefined,
    });
    await db.insert(container_usage_segment).values({
      interval_id: id,
      seq: 1,
      idempotency_key: id,
      reported_seconds: seconds,
      usage_seconds: seconds,
      received_at: date,
    });
  }
  await db.insert(compute_usage_charge).values({
    usage_source: 'container_usage_segment',
    usage_source_id: id,
    cloud_billing_sku_id: input.skuId,
    user_id: input.userId,
    organization_id: input.orgId,
    quantity: String(seconds),
    rate_cents_per_unit: '0.01',
    amount_microdollars: seconds * 100,
    created_at: date,
  });
}

describe('customer compute billing PostgreSQL queries', () => {
  it('returns runtime SKU rates and keeps missing prices unavailable', async () => {
    const user = await insertTestUser();
    await db.insert(cloud_billing_sku).values({
      id: CLOUD_AGENT_CONTAINER_SKUS['standard-3'],
      name: 'Native medium',
      unit: 'second',
      rate_cents_per_unit: '0.0025',
    });
    const rates = await createCaller({ user }).rates();
    expect(rates.find(rate => rate.instance === 'standard-3')).toMatchObject({
      hourlyUsd: 0.09,
      available: true,
    });
    expect(rates.find(rate => rate.instance === 'standard-4')).toMatchObject({
      hourlyUsd: null,
      available: false,
    });
    expect(formatComputePrice(0.09)).toBe('$0.09/hour');
    expect(formatComputePrice(null)).toBe('Price unavailable');
    expect(formatComputePrice(0.00000001)).toBe('<$0.000001/hour');
  });

  it('reports exact amounts and durations by day or session, retaining shared and unlinked charges', async () => {
    const { owner, outsider, skuId } = await fixture();
    await charge({ skuId, userId: owner.id, sessionId: 'workspace_test' });
    await charge({ skuId, userId: owner.id, sessionId: 'workspace_test', seconds: 60 });
    await charge({
      skuId,
      userId: owner.id,
      sessionId: 'workspace_test',
      seconds: 60,
      day: '2026-10-25T00:01:00.000Z',
    });
    await charge({ skuId, userId: owner.id, seconds: 30 });
    await charge({ skuId, userId: owner.id, unlinked: true, seconds: 10 });
    await charge({ skuId, userId: outsider.id, seconds: 999 });
    const caller = createCaller({ user: owner });
    const daily = await caller.charges(range);
    expect(daily.payer).toEqual({ type: 'user', id: owner.id });
    expect(daily.rows.reduce((total, row) => total + row.seconds, 0)).toBe(280);
    expect(daily.rows.reduce((total, row) => total + row.amountMicrodollars, 0)).toBe(28_000);
    expect(daily.rows.every(row => row.rateCentsPerSecond === 0.01)).toBe(true);
    const sessions = await caller.charges({ ...range, groupBy: 'session' });
    expect(sessions.rows.find(row => row.sessionId === 'workspace_test')).toMatchObject({
      seconds: 240,
      amountMicrodollars: 24_000,
    });
    expect(
      sessions.rows.filter(row => row.sessionId === null).reduce((sum, row) => sum + row.seconds, 0)
    ).toBe(40);
  });

  it('limits organization members to their own compute and permits billing roles to inspect all members', async () => {
    const { owner, member, outsider, org, skuId } = await fixture();
    await charge({ skuId, orgId: org.id, actorId: owner.id, seconds: 100 });
    await charge({ skuId, orgId: org.id, actorId: member.id, bot: true, seconds: 200 });
    await charge({ skuId, orgId: org.id, unlinked: true, seconds: 300 });
    const input = { ...range, organizationId: org.id };
    const own = await createCaller({ user: member }).charges(input);
    expect(own.rows).toHaveLength(1);
    expect(own.rows[0]).toMatchObject({ memberId: member.id, seconds: 200 });
    expect(own.payer).toEqual({ type: 'org', id: org.id });
    const all = await createCaller({ user: owner }).charges({ ...input, view: 'all' });
    expect(all.rows.reduce((sum, row) => sum + row.seconds, 0)).toBe(600);
    await expect(
      createCaller({ user: member }).charges({ ...input, view: 'all' })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(createCaller({ user: outsider }).charges(input)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('bounds dates and pagination', async () => {
    const { owner } = await fixture();
    await expect(
      createCaller({ user: owner }).charges({ ...range, endDate: range.startDate })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      createCaller({ user: owner }).charges({ ...range, page: -1 })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('pages session groups without omitting or repeating charges', async () => {
    const { owner, skuId } = await fixture();
    await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        charge({
          skuId,
          userId: owner.id,
          sessionId: `workspace_${String(index).padStart(3, '0')}`,
        })
      )
    );
    const caller = createCaller({ user: owner });
    const first = await caller.charges({ ...range, groupBy: 'session' });
    const second = await caller.charges({ ...range, groupBy: 'session', page: 1 });
    expect(first.rows).toHaveLength(100);
    expect(first.hasMore).toBe(true);
    expect(second.rows).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(new Set([...first.rows, ...second.rows].map(row => row.sessionId)).size).toBe(101);
  });
});
