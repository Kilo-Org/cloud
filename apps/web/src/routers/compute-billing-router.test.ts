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
import { and, eq, sql } from 'drizzle-orm';
import {
  CLOUD_AGENT_CONTAINER_SKUS,
  SANDBOX_USAGE_SKUS,
} from '@kilocode/worker-utils/cloud-agent-compute';
import { computeBillingRouter, computeChargesInputSchema } from './compute-billing-router';
import { formatComputePrice } from '@/lib/cloud-agent/compute-price';
import { containerInstanceForSku } from '@/lib/cloud-agent/compute-billing';
import type * as CodeReviewComputeBilling from '@/lib/code-reviews/compute-billing';
import {
  isCodeReviewComputeBillingEnabled,
  readCodeReviewContainerCost,
} from '@/lib/code-reviews/compute-billing';

jest.mock('@/lib/code-reviews/compute-billing', () => ({
  ...jest.requireActual<typeof CodeReviewComputeBilling>('@/lib/code-reviews/compute-billing'),
  isCodeReviewComputeBillingEnabled: jest.fn(),
}));

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

async function run(input: {
  skuId: string;
  userId: string;
  sessionId: string;
  startedAt: string;
  segments: number[];
  stopped?: boolean;
  rate?: string;
}) {
  const id = crypto.randomUUID();
  const rate = input.rate ?? '0.01';
  const seconds = input.segments.reduce((sum, value) => sum + value, 0);
  const endedAt = new Date(Date.parse(input.startedAt) + seconds * 1000).toISOString();
  await db.insert(container_usage_interval).values({
    id,
    service: 'cloud-agent-next-sandbox-containers-standard3',
    instance_id: id,
    start_epoch_ms: Date.parse(input.startedAt),
    cloud_billing_sku_id: input.skuId,
    context_fingerprint: 'a'.repeat(64),
    subject_type: 'user',
    subject_id: input.userId,
    actor_type: 'user',
    actor_id: input.userId,
    session_id: input.sessionId,
    started_at: input.startedAt,
    last_seen_at: endedAt,
    billing_mode: 'paid',
    rate_cents_per_unit: rate,
    ...(input.stopped ? { status: 'closed', stopped_at: endedAt, close_reason: 'exit' } : {}),
  });
  for (const [index, segmentSeconds] of input.segments.entries()) {
    const key = `${id}:${index + 1}`;
    await db.insert(container_usage_segment).values({
      interval_id: id,
      seq: index + 1,
      idempotency_key: key,
      reported_seconds: segmentSeconds,
      usage_seconds: segmentSeconds,
      received_at: endedAt,
    });
    await db.insert(compute_usage_charge).values({
      usage_source: 'container_usage_segment',
      usage_source_id: key,
      cloud_billing_sku_id: input.skuId,
      user_id: input.userId,
      quantity: String(segmentSeconds),
      rate_cents_per_unit: rate,
      amount_microdollars: Math.round(segmentSeconds * Number(rate) * 10_000),
      created_at: endedAt,
    });
  }
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
    expect(await caller.sessionCharges({ cloudAgentSessionId: root })).toMatchObject(expected);
    expect(await caller.sessionCharges({ cloudAgentSessionId: sibling })).toMatchObject(expected);
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
      runs: [],
      earlierRuns: null,
    });
    await charge({ skuId, userId: owner.id, sessionId: first, seconds: 20 });
    await charge({ skuId, userId: owner.id, sessionId: second, seconds: 90 });
    expect(await caller.sessionCharges({ cloudAgentSessionId: first })).toMatchObject({
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
    expect(await caller.sessionCharges(input)).toMatchObject({
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

  it('lists the most recent runs with their duration, rate, and amount, and reconciles earlier runs', async () => {
    const { owner, outsider, skuId } = await fixture();
    const worktreeId = `worktree_${crypto.randomUUID()}`;
    const root = await session({ userId: owner.id, worktreeId });
    const sibling = await session({ userId: owner.id, worktreeId });
    const largeSku = `compute-report-large-${crypto.randomUUID()}`;
    await db
      .insert(cloud_billing_sku)
      .values({ id: largeSku, name: 'Large', unit: 'second', rate_cents_per_unit: '0.0333' });
    const start = Date.parse('2026-11-10T13:00:00.000Z');
    for (let index = 0; index < 11; index++) {
      await run({
        skuId,
        userId: owner.id,
        sessionId: index % 2 === 0 ? root : sibling,
        startedAt: new Date(start + index * 3_600_000).toISOString(),
        segments: [60, 60 * (index + 1)],
        stopped: true,
      });
    }
    const latest = new Date(start + 11 * 3_600_000).toISOString();
    await run({
      skuId: largeSku,
      userId: owner.id,
      sessionId: sibling,
      startedAt: latest,
      segments: [600],
      rate: '0.0333',
    });
    await run({ skuId, userId: outsider.id, sessionId: root, startedAt: latest, segments: [999] });

    const charges = await createCaller({ user: owner }).sessionCharges({
      cloudAgentSessionId: root,
    });
    expect(charges.runs).toHaveLength(10);
    expect(charges.runs[0]).toEqual({
      startedAt: latest,
      stoppedAt: null,
      running: true,
      instance: null,
      rateCentsPerSecond: 0.0333,
      seconds: 600,
      amountMicrodollars: Math.round(600 * 0.0333 * 10_000),
    });
    expect(charges.runs[1]).toMatchObject({
      startedAt: new Date(start + 10 * 3_600_000).toISOString(),
      running: false,
      instance: null,
      rateCentsPerSecond: 0.01,
      seconds: 60 + 660,
      amountMicrodollars: (60 + 660) * 100,
    });
    expect(charges.runs[1]?.stoppedAt).not.toBeNull();
    expect(charges.earlierRuns).toEqual({
      count: 2,
      seconds: 60 + 60 + 60 + 120,
      amountMicrodollars: (60 + 60 + 60 + 120) * 100,
    });
    const listed = charges.runs.reduce((sum, item) => sum + item.amountMicrodollars, 0);
    expect(listed + (charges.earlierRuns?.amountMicrodollars ?? 0)).toBe(
      charges.amountMicrodollars
    );
  });

  it('names only Cloud Agent container SKUs by instance', () => {
    expect(containerInstanceForSku(CLOUD_AGENT_CONTAINER_SKUS['standard-3'])).toBe('standard-3');
    expect(containerInstanceForSku(CLOUD_AGENT_CONTAINER_SKUS['standard-4'])).toBe('standard-4');
    expect(containerInstanceForSku('cloud-agent-standard-2026-07')).toBeNull();
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
  it('prices paid code reviews from their dedicated SKU, not a chat container SKU', async () => {
    const user = await insertTestUser();
    jest.mocked(isCodeReviewComputeBillingEnabled).mockResolvedValueOnce(true);
    await db.insert(cloud_billing_sku).values({
      id: SANDBOX_USAGE_SKUS.SandboxContainersCodeReview,
      name: 'Code review compute',
      unit: 'second',
      rate_cents_per_unit: '0.005',
    });
    await expect(createCaller({ user }).codeReviewRate({})).resolves.toEqual({
      enabled: true,
      hourlyUsd: 0.18,
    });
    expect(isCodeReviewComputeBillingEnabled).toHaveBeenLastCalledWith({
      type: 'user',
      id: user.id,
    });
    await db
      .delete(cloud_billing_sku)
      .where(eq(cloud_billing_sku.id, SANDBOX_USAGE_SKUS.SandboxContainersCodeReview));
  });

  it('does not show paid pricing for shadow-mode accounts', async () => {
    const user = await insertTestUser();
    jest.mocked(isCodeReviewComputeBillingEnabled).mockResolvedValueOnce(false);
    await expect(createCaller({ user }).codeReviewRate({})).resolves.toEqual({
      enabled: false,
      hourlyUsd: null,
    });
  });

  it('does not invent a missing code review price', async () => {
    const user = await insertTestUser();
    jest.mocked(isCodeReviewComputeBillingEnabled).mockResolvedValueOnce(true);
    await expect(createCaller({ user }).codeReviewRate({})).resolves.toEqual({
      enabled: true,
      hourlyUsd: null,
    });
  });

  it.each([
    { unit: 'second', accepts_new_usage: false },
    { unit: 'hour', accepts_new_usage: true },
  ] as const)('does not advertise an unusable code review SKU: %o', async sku => {
    const user = await insertTestUser();
    jest.mocked(isCodeReviewComputeBillingEnabled).mockResolvedValueOnce(true);
    await db.insert(cloud_billing_sku).values({
      id: SANDBOX_USAGE_SKUS.SandboxContainersCodeReview,
      name: 'Unavailable code review compute',
      rate_cents_per_unit: '0.005',
      ...sku,
      unit: sql`${sku.unit}`,
    });
    try {
      await expect(createCaller({ user }).codeReviewRate({})).resolves.toEqual({
        enabled: true,
        hourlyUsd: null,
      });
    } finally {
      await db
        .delete(cloud_billing_sku)
        .where(eq(cloud_billing_sku.id, SANDBOX_USAGE_SKUS.SandboxContainersCodeReview));
    }
  });

  it('authorizes organization pricing and uses the organization payer', async () => {
    const { owner, outsider, org } = await fixture();
    jest.mocked(isCodeReviewComputeBillingEnabled).mockResolvedValueOnce(false);
    await createCaller({ user: owner }).codeReviewRate({ organizationId: org.id });
    expect(isCodeReviewComputeBillingEnabled).toHaveBeenLastCalledWith({ type: 'org', id: org.id });
    await expect(
      createCaller({ user: outsider }).codeReviewRate({ organizationId: org.id })
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
  });

  it('sums review container charges across attempts without duplicate sessions or other payers', async () => {
    const { owner, outsider, org, skuId } = await fixture();
    await charge({ skuId, userId: owner.id, sessionId: 'workspace_review_a', seconds: 120 });
    await charge({
      skuId,
      userId: owner.id,
      sessionId: 'workspace_review_b',
      seconds: 60,
      day: '2026-11-01T12:00:00.000Z',
    });
    await charge({ skuId, userId: outsider.id, sessionId: 'workspace_review_a', seconds: 999 });
    await charge({
      skuId,
      orgId: org.id,
      actorId: owner.id,
      bot: true,
      sessionId: 'workspace_review_a',
      seconds: 30,
    });
    await expect(
      readCodeReviewContainerCost(
        db,
        { type: 'user', id: owner.id },
        ['workspace_review_a', 'workspace_review_a', 'workspace_review_b'],
        range.startDate
      )
    ).resolves.toBe(18_000);
    await expect(
      readCodeReviewContainerCost(
        db,
        { type: 'org', id: org.id },
        ['workspace_review_a'],
        range.startDate
      )
    ).resolves.toBe(3_000);
    await expect(
      readCodeReviewContainerCost(db, { type: 'user', id: owner.id }, [], range.startDate)
    ).resolves.toBeNull();
    await expect(
      readCodeReviewContainerCost(db, { type: 'user', id: owner.id }, ['missing'], range.startDate)
    ).resolves.toBeNull();
    await expect(
      readCodeReviewContainerCost(
        db,
        { type: 'user', id: owner.id },
        ['workspace_review_a', 'workspace_review_b'],
        '2026-11-01 12:00:00+00'
      )
    ).resolves.toBe(6_000);
  });

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
