import { describe, expect, it } from '@jest/globals';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createCallerFactory } from '@kilocode/web-shared/lib/trpc/init';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import {
  cli_sessions_v2,
  cloud_billing_sku,
  compute_usage_charge,
  container_usage_interval,
  container_usage_segment,
  organization_memberships,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import { CLOUD_AGENT_CONTAINER_SKUS } from '@kilocode/worker-utils/cloud-agent-compute';
import { computeBillingRouter, computeChargesInputSchema } from './compute-billing-router';
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

async function session(input: { userId: string; orgId?: string; worktreeId?: string }) {
  const cloudAgentSessionId = `workspace_${crypto.randomUUID()}`;
  await db.insert(cli_sessions_v2).values({
    session_id: `ses_compute_${crypto.randomUUID()}`,
    kilo_user_id: input.userId,
    organization_id: input.orgId,
    cloud_agent_session_id: cloudAgentSessionId,
    cloud_agent_worktree_id: input.worktreeId,
  });
  return cloudAgentSessionId;
}

describe('session compute charges', () => {
  it('sums recorded charges across restarts and all chats in the owned workspace', async () => {
    const { owner, outsider, skuId } = await fixture();
    const worktreeId = `worktree_${crypto.randomUUID()}`;
    const root = await session({ userId: owner.id, worktreeId });
    const sibling = await session({ userId: owner.id, worktreeId });
    const otherWorkspace = await session({ userId: owner.id });
    const foreign = await session({ userId: outsider.id, worktreeId });
    await charge({ skuId, userId: owner.id, sessionId: root, seconds: 100 });
    await charge({
      skuId,
      userId: owner.id,
      sessionId: root,
      seconds: 200,
      day: '2026-11-02T00:00:00.000Z',
    });
    await charge({ skuId, userId: owner.id, sessionId: sibling, seconds: 300 });
    await charge({ skuId, userId: owner.id, sessionId: otherWorkspace, seconds: 900 });
    await charge({ skuId, userId: outsider.id, sessionId: root, seconds: 900 });
    await charge({ skuId, userId: owner.id, sessionId: foreign, seconds: 900 });
    const caller = createCaller({ user: owner });
    const expected = { amountMicrodollars: 60_000, seconds: 600, scope: 'workspace' };
    expect(await caller.sessionCharges({ cloudAgentSessionId: root })).toEqual(expected);
    expect(await caller.sessionCharges({ cloudAgentSessionId: sibling })).toEqual(expected);
  });

  it('returns zero without paid charges and does not combine worktree-less sessions', async () => {
    const { owner, skuId } = await fixture();
    const first = await session({ userId: owner.id });
    const second = await session({ userId: owner.id });
    const caller = createCaller({ user: owner });
    expect(await caller.sessionCharges({ cloudAgentSessionId: first })).toEqual({
      amountMicrodollars: 0,
      seconds: 0,
      scope: 'session',
    });
    await charge({ skuId, userId: owner.id, sessionId: first, seconds: 20 });
    await charge({ skuId, userId: owner.id, sessionId: second, seconds: 90 });
    expect(await caller.sessionCharges({ cloudAgentSessionId: first })).toEqual({
      amountMicrodollars: 2_000,
      seconds: 20,
      scope: 'session',
    });
  });

  it('requires session ownership and the exact payer scope, including for organization billing roles', async () => {
    const { owner, member, outsider, org, skuId } = await fixture();
    const worktreeId = `worktree_${crypto.randomUUID()}`;
    const own = await session({ userId: member.id, orgId: org.id, worktreeId });
    const personal = await session({ userId: member.id, worktreeId });
    await charge({
      skuId,
      orgId: org.id,
      actorId: member.id,
      bot: true,
      sessionId: own,
      seconds: 200,
    });
    await charge({ skuId, userId: member.id, sessionId: personal, seconds: 900 });
    const input = { cloudAgentSessionId: own, organizationId: org.id };
    const caller = createCaller({ user: member });
    expect(await caller.sessionCharges(input)).toEqual({
      amountMicrodollars: 20_000,
      seconds: 200,
      scope: 'workspace',
    });
    for (const user of [owner, outsider]) {
      await expect(createCaller({ user }).sessionCharges(input)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      });
    }
    await expect(caller.sessionCharges({ cloudAgentSessionId: own })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
    await expect(
      caller.sessionCharges({ ...input, cloudAgentSessionId: personal })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      caller.sessionCharges({ ...input, organizationId: crypto.randomUUID() })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await db
      .delete(organization_memberships)
      .where(
        and(
          eq(organization_memberships.organization_id, org.id),
          eq(organization_memberships.kilo_user_id, member.id)
        )
      );
    await expect(caller.sessionCharges(input)).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects nonexistent sessions', async () => {
    const user = await insertTestUser();
    await expect(
      createCaller({ user }).sessionCharges({
        cloudAgentSessionId: `workspace_${crypto.randomUUID()}`,
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});

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
    expect(formatComputePrice(0.09)).toBe('~$0.09/hr');
    expect(formatComputePrice(1.20312)).toBe('~$1.20/hr');
    expect(formatComputePrice(null)).toBe('Price unavailable');
    expect(formatComputePrice(0.00000001)).toBe('<$0.01/hr');
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

describe('compute charge pagination bounds', () => {
  it('rejects offsets beyond the report limit', () => {
    expect(computeChargesInputSchema.safeParse({ ...range, page: 20 }).success).toBe(true);
    expect(computeChargesInputSchema.safeParse({ ...range, page: 21 }).success).toBe(false);
  });
});
