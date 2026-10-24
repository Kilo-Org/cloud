import { afterAll, describe, expect, it, vi } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  cloud_billing_sku,
  compute_usage_charge,
  container_usage_interval,
  credit_transactions,
  kilo_pass_org_agreements,
  kilo_pass_org_issuance_snapshots,
  kilo_pass_org_qualifying_spend_events,
  kilo_pass_org_term_versions,
  kilocode_users,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  organizations,
} from '@kilocode/db/schema';
import {
  KiloPassOrgAgreementState,
  KiloPassOrgBonusMode,
  KiloPassOrgIssuanceKind,
  KiloPassOrgPurchaseChannel,
} from '@kilocode/db/schema-types';
import {
  heartbeatIdempotencyKey,
  startIdempotencyKey,
  usageContextFingerprint,
  type UsageContext,
} from '@kilocode/container-usage';
import { recordOrganizationConsumption } from '@kilocode/worker-utils/organization-consumption';
import { and, eq, sql } from 'drizzle-orm';
import { applyHeartbeatWithDb, applyStartWithDb } from '../src/postgres';
import { type BillingConfig } from '../src/billing-config';

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {
    constructor(
      public ctx: ExecutionContext,
      public env: Cloudflare.Env
    ) {}
  },
}));
import { ContainerUsageMeter } from '../src/meter';

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) throw new Error('Set POSTGRES_URL to the isolated local test database');
const client = createDrizzleClient({ connectionString, ssl: false });
const fixtures: { userId: string; orgId: string; skuId: string }[] = [];

afterAll(async () => {
  for (const f of fixtures) {
    await client.db
      .delete(compute_usage_charge)
      .where(eq(compute_usage_charge.organization_id, f.orgId));
    await client.db
      .delete(container_usage_interval)
      .where(eq(container_usage_interval.subject_id, f.orgId));
    await client.db
      .delete(kilo_pass_org_qualifying_spend_events)
      .where(
        eq(kilo_pass_org_qualifying_spend_events.allocation_container_organization_id, f.orgId)
      );
    await client.db
      .delete(kilo_pass_org_issuance_snapshots)
      .where(eq(kilo_pass_org_issuance_snapshots.allocation_container_organization_id, f.orgId));
    const agreements = await client.db
      .delete(kilo_pass_org_agreements)
      .where(eq(kilo_pass_org_agreements.parent_organization_id, f.orgId))
      .returning({ termId: kilo_pass_org_agreements.term_version_id });
    await client.db
      .delete(credit_transactions)
      .where(eq(credit_transactions.organization_id, f.orgId));
    for (const agreement of agreements)
      await client.db
        .delete(kilo_pass_org_term_versions)
        .where(eq(kilo_pass_org_term_versions.id, agreement.termId));
    await client.db.delete(organizations).where(eq(organizations.id, f.orgId));
    await client.db.delete(kilocode_users).where(eq(kilocode_users.id, f.userId));
    await client.db.delete(cloud_billing_sku).where(eq(cloud_billing_sku.id, f.skuId));
  }
  await client.pool.end();
});

async function fixture() {
  const f = {
    userId: crypto.randomUUID(),
    orgId: crypto.randomUUID(),
    skuId: `compute-member-${crypto.randomUUID()}`,
  };
  fixtures.push(f);
  await client.db.insert(kilocode_users).values({
    id: f.userId,
    google_user_email: `${f.userId}@example.com`,
    google_user_name: 'Compute member',
    google_user_image_url: '',
    stripe_customer_id: `cus_${f.userId}`,
  });
  await client.db.insert(organizations).values({
    id: f.orgId,
    name: 'Compute accounting',
    require_seats: false,
    total_microdollars_acquired: 20_000_000,
    microdollars_balance: 20_000_000,
  });
  await client.db
    .insert(organization_memberships)
    .values({ organization_id: f.orgId, kilo_user_id: f.userId, role: 'member' });
  await client.db.insert(organization_user_limits).values({
    organization_id: f.orgId,
    kilo_user_id: f.userId,
    limit_type: 'daily',
    microdollar_limit: 10_000_000,
  });
  await client.db.insert(cloud_billing_sku).values({
    id: f.skuId,
    name: 'Compute member fixture',
    unit: 'second',
    rate_cents_per_unit: '1',
  });
  const context: UsageContext = {
    service: 'cloud-agent-next-sandbox-containers-standard3',
    instanceId: crypto.randomUUID(),
    sku: f.skuId,
    subject: { type: 'org', id: f.orgId },
    actor: { type: 'bot', id: 'webhook' },
    onBehalfOf: { type: 'org', id: f.orgId },
    metadata: { billingUserId: f.userId },
  };
  const start = new Date().setUTCHours(12, 0, 0, 0);
  const config: BillingConfig = {
    enabled: true,
    services: new Set(['cloud-agent-next']),
    userIds: new Set(),
    orgIds: new Set(),
    cloudAgentUserIds: new Set(),
    cloudAgentOrgIds: new Set([f.orgId]),
    warnRemainingMicrodollars: 10_000_000,
  };
  const fingerprint = await usageContextFingerprint(context);
  const intervalId = `${context.service}:${context.instanceId}:${start}`;
  const admission = () =>
    applyStartWithDb(
      client.db,
      {
        ...context,
        startEpochMs: start,
        idempotencyKey: startIdempotencyKey(context.service, context.instanceId, start),
      },
      intervalId,
      fingerprint,
      start,
      config
    );
  const heartbeatInput = {
    service: context.service,
    instanceId: context.instanceId,
    startEpochMs: start,
    seq: 1,
    usageSinceLast: 300,
    idempotencyKey: heartbeatIdempotencyKey(context.service, context.instanceId, start, 1),
    context,
  };
  const heartbeat = () =>
    applyHeartbeatWithDb(
      client.db,
      heartbeatInput,
      intervalId,
      fingerprint,
      start + 300_000,
      config
    );
  const usage = async () =>
    (
      await client.db
        .select()
        .from(organization_user_usage)
        .where(
          and(
            eq(organization_user_usage.organization_id, f.orgId),
            eq(organization_user_usage.kilo_user_id, f.userId)
          )
        )
    )[0]?.microdollar_usage;
  const payer = async () =>
    (await client.db.select().from(organizations).where(eq(organizations.id, f.orgId)))[0];
  const limit = (amount: number) =>
    client.db
      .update(organization_user_limits)
      .set({ microdollar_limit: amount })
      .where(eq(organization_user_limits.organization_id, f.orgId));
  return {
    ...f,
    context,
    start,
    config,
    fingerprint,
    intervalId,
    admission,
    heartbeatInput,
    heartbeat,
    usage,
    payer,
    limit,
  };
}

describe('native organization compute accounting', () => {
  it('blocks a $1.50 allowance, counts a running $3 charge once and recovers only after the allowance rises', async () => {
    const f = await fixture();
    await f.limit(1_500_000);
    expect(await f.admission()).toMatchObject({
      kind: 'rejected',
      code: 'insufficient_credits',
      remainingMicrodollars: 1_500_000,
    });
    await f.limit(10_000_000);
    expect(await f.admission()).toMatchObject({ kind: 'applied', billingMode: 'paid' });
    await f.limit(1_500_000);
    expect(await f.heartbeat()).toMatchObject({
      budget: { verdict: 'stop', remainingMicrodollars: 0 },
    });
    expect(await f.usage()).toBe(3_000_000);
    expect((await f.payer()).microdollars_used).toBe(3_000_000);
    expect(await f.heartbeat()).toMatchObject({ dedup: true });
    expect(await f.usage()).toBe(3_000_000);
    const charges = await client.db
      .select()
      .from(compute_usage_charge)
      .where(eq(compute_usage_charge.organization_id, f.orgId));
    expect(charges).toHaveLength(1);
    await client.db
      .update(organizations)
      .set({ total_microdollars_acquired: 50_000_000 })
      .where(eq(organizations.id, f.orgId));
    const nextContext = { ...f.context, instanceId: crypto.randomUUID() };
    const fp = await usageContextFingerprint(nextContext);
    const admitNext = () =>
      applyStartWithDb(
        client.db,
        {
          ...nextContext,
          startEpochMs: f.start,
          idempotencyKey: startIdempotencyKey(nextContext.service, nextContext.instanceId, f.start),
        },
        `${f.intervalId}-next`,
        fp,
        f.start,
        f.config
      );
    expect(await admitNext()).toMatchObject({ kind: 'rejected', code: 'insufficient_credits' });
    await f.limit(10_000_000);
    expect(await admitNext()).toMatchObject({ kind: 'applied', billingMode: 'paid' });
  });

  it('keeps seat-based exemption while still recording daily compute usage', async () => {
    const f = await fixture();
    await f.limit(1_500_000);
    await client.db
      .update(organizations)
      .set({ require_seats: true })
      .where(eq(organizations.id, f.orgId));
    expect(await f.admission()).toMatchObject({ kind: 'applied' });
    expect(await f.heartbeat()).toMatchObject({ budget: { verdict: 'continue' } });
    expect(await f.usage()).toBe(3_000_000);
  });

  it('stops after membership removal and settles the measured wallet charge', async () => {
    const f = await fixture();
    await f.admission();
    await client.db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, f.orgId));
    expect(await f.heartbeat()).toMatchObject({ budget: { verdict: 'stop' } });
    expect((await f.payer()).microdollars_used).toBe(3_000_000);
  });

  it('serializes gateway and compute debits with the shared member-before-wallet lock order', async () => {
    const f = await fixture();
    await f.admission();
    let releaseGateway: () => void = () => {};
    const release = new Promise<void>(resolve => {
      releaseGateway = resolve;
    });
    let gatewayReady: () => void = () => {};
    const ready = new Promise<void>(resolve => {
      gatewayReady = resolve;
    });
    const gateway = client.db.transaction(async tx => {
      await recordOrganizationConsumption(tx, {
        organizationId: f.orgId,
        kiloUserId: f.userId,
        amountMicrodollars: 500_000,
        occurredAt: new Date(f.start).toISOString(),
        source: 'ai-gateway',
        sourceId: crypto.randomUUID(),
      });
      gatewayReady();
      await release;
    });
    await ready;
    const compute = f.heartbeat();
    try {
      // Observe an actual lock wait while the gateway transaction remains open.
      await vi.waitFor(async () => {
        const waiting = await client.db.execute<{ waiting: boolean }>(sql`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
          AND wait_event_type = 'Lock' AND pid <> pg_backend_pid()
        ) AS waiting`);
        expect(waiting.rows[0].waiting).toBe(true);
      });
    } finally {
      releaseGateway();
      await Promise.all([gateway, compute]);
    }
    expect(await f.usage()).toBe(3_500_000);
    expect((await f.payer()).microdollars_used).toBe(3_500_000);
  });

  it('settles an old unattributed bot interval once, stops it, and refuses an unattributed new paid start', async () => {
    const f = await fixture();
    delete f.context.metadata;
    const fp = await usageContextFingerprint(f.context);
    const startInput = {
      ...f.context,
      startEpochMs: f.start,
      idempotencyKey: startIdempotencyKey(f.context.service, f.context.instanceId, f.start),
    };
    await expect(
      applyStartWithDb(client.db, startInput, f.intervalId, fp, f.start, f.config)
    ).rejects.toThrow('acting member');
    await applyStartWithDb(client.db, startInput, f.intervalId, fp, f.start);
    await client.db
      .update(container_usage_interval)
      .set({ billing_mode: 'paid', rate_cents_per_unit: '1' })
      .where(eq(container_usage_interval.id, f.intervalId));
    const heartbeat = () =>
      applyHeartbeatWithDb(
        client.db,
        f.heartbeatInput,
        f.intervalId,
        fp,
        f.start + 300_000,
        f.config
      );
    expect(await heartbeat()).toMatchObject({ budget: { verdict: 'stop' } });
    expect(await heartbeat()).toMatchObject({ dedup: true });
    expect((await f.payer()).microdollars_used).toBe(3_000_000);
    expect(await f.usage()).toBeUndefined();
  });

  it.each([
    { requireSeats: true, conflict: false },
    { requireSeats: false, conflict: false },
    { requireSeats: false, conflict: true },
  ])(
    'enforces member and consumption invariants: $requireSeats / $conflict',
    async ({ requireSeats, conflict }) => {
      const f = await fixture();
      await client.db
        .update(organizations)
        .set({
          total_microdollars_acquired: 50_000_000,
          microdollars_balance: 50_000_000,
          require_seats: requireSeats,
        })
        .where(eq(organizations.id, f.orgId));
      await f.limit(25_000_000);
      const [term] = await client.db
        .insert(kilo_pass_org_term_versions)
        .values({
          version_key: `compute-${f.orgId}`,
          tier: 'tier_19',
          cadence: 'monthly',
          billing_price_microdollars_per_pass: 19_000_000,
          base_credit_microdollars_per_pass: 19_000_000,
          bonus_credit_microdollars_per_pass: 3_800_000,
          unlock_spend_microdollars_per_pass: 19_000_000,
          bonus_mode: KiloPassOrgBonusMode.AfterBase,
        })
        .returning();
      const windowStart = new Date(f.start - 3_600_000).toISOString();
      const windowEnd = new Date(f.start + 86_400_000).toISOString();
      const [agreement] = await client.db
        .insert(kilo_pass_org_agreements)
        .values({
          parent_organization_id: f.orgId,
          term_version_id: term.id,
          state: KiloPassOrgAgreementState.Active,
          purchase_channel: KiloPassOrgPurchaseChannel.SelfServe,
          cadence: 'monthly',
          purchased_pass_capacity: 1,
          issuance_anchor_at: windowStart,
        })
        .returning();
      const [snapshot] = await client.db
        .insert(kilo_pass_org_issuance_snapshots)
        .values({
          agreement_id: agreement.id,
          term_version_id: term.id,
          allocation_container_organization_id: f.orgId,
          window_start: windowStart,
          window_end: windowEnd,
          qualifying_spend_starts_at: windowStart,
          kind: KiloPassOrgIssuanceKind.Regular,
          tranche_key: 'regular',
          allocated_pass_capacity: 1,
          base_credit_microdollars: 19_000_000,
          bonus_credit_microdollars: 3_800_000,
          unlock_spend_microdollars: 19_000_000,
          bonus_mode: KiloPassOrgBonusMode.AfterBase,
        })
        .returning();
      await client.db.transaction(tx =>
        recordOrganizationConsumption(tx, {
          organizationId: f.orgId,
          kiloUserId: f.userId,
          amountMicrodollars: 17_000_000,
          occurredAt: new Date(f.start).toISOString(),
          source: 'ai-gateway',
          sourceId: crypto.randomUUID(),
        })
      );
      await f.admission();
      if (conflict) {
        await client.db.insert(credit_transactions).values({
          kilo_user_id: f.userId,
          organization_id: f.orgId,
          amount_microdollars: -3_000_000,
          is_free: false,
          credit_category: `kpo:consumption:compute:${f.heartbeatInput.idempotencyKey}`,
          check_category_uniqueness: true,
        });
        await expect(f.heartbeat()).rejects.toThrow('already recorded without its segment');
        expect((await f.payer()).microdollars_used).toBe(17_000_000);
        expect(await f.usage()).toBe(17_000_000);
        const charges = await client.db
          .select()
          .from(compute_usage_charge)
          .where(eq(compute_usage_charge.organization_id, f.orgId));
        expect(charges).toHaveLength(0);
        return;
      }
      const result = await f.heartbeat();
      expect(result).toMatchObject({ budget: { verdict: requireSeats ? 'continue' : 'warn' } });
      await f.heartbeat();
      expect(await f.usage()).toBe(20_000_000);
      if (!requireSeats)
        expect(result).toMatchObject({ budget: { remainingMicrodollars: 5_000_000 } });
      const [updated] = await client.db
        .select()
        .from(kilo_pass_org_issuance_snapshots)
        .where(eq(kilo_pass_org_issuance_snapshots.id, snapshot.id));
      expect(updated.qualifying_spend_microdollars).toBe(20_000_000);
      expect(updated.bonus_unlocked_at).not.toBeNull();
      const bonuses = await client.db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.credit_category, `kpo:bonus-unlock:${snapshot.id}`));
      expect(bonuses).toHaveLength(1);
      const events = await client.db
        .select()
        .from(kilo_pass_org_qualifying_spend_events)
        .where(eq(kilo_pass_org_qualifying_spend_events.issuance_snapshot_id, snapshot.id));
      expect(events).toHaveLength(2);
      expect(events.reduce((sum, event) => sum + event.spent_microdollars, 0)).toBe(20_000_000);
      const debits = await client.db
        .select()
        .from(credit_transactions)
        .where(
          and(
            eq(credit_transactions.organization_id, f.orgId),
            eq(
              credit_transactions.credit_category,
              `kpo:consumption:compute:${f.heartbeatInput.idempotencyKey}`
            )
          )
        );
      expect(debits).toHaveLength(1);
      expect(debits[0].kilo_user_id).toBe(f.userId);
      expect((await f.payer()).microdollars_used).toBe(20_000_000);
    }
  );

  it('requests one authenticated balance alert after commit and none on replay', async () => {
    const f = await fixture();
    await client.db
      .update(organizations)
      .set({
        settings: { minimum_balance: 18, minimum_balance_alert_email: ['billing@example.com'] },
      })
      .where(eq(organizations.id, f.orgId));
    const pending: Promise<unknown>[] = [];
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (!(url instanceof URL)) throw new Error('Expected a resolved alert URL');
      expect(url.href).toBe(
        'https://local-web.invalid/api/internal/organizations/compute-balance-alert'
      );
      expect(new Headers(init?.headers).get('X-Internal-Secret')).toBe('fixture-secret');
      expect(JSON.parse(init?.body as string)).toEqual({ organizationId: f.orgId });
      expect((await f.payer()).microdollars_used).toBe(3_000_000);
      return Response.json({ ok: true });
    });
    const clock = vi.spyOn(Date, 'now').mockReturnValue(f.start);
    const meter = new ContainerUsageMeter(
      {
        waitUntil: (promise: Promise<unknown>) => pending.push(promise),
      } as unknown as ExecutionContext,
      {
        HYPERDRIVE: { connectionString },
        KILOCODE_BACKEND_BASE_URL: 'https://local-web.invalid',
        INTERNAL_API_SECRET_PROD: { get: async () => 'fixture-secret' },
        CONTAINER_BILLING_SERVICES: 'cloud-agent-next',
        CONTAINER_BILLING_CLOUD_AGENT_USER_IDS: '',
        CONTAINER_BILLING_CLOUD_AGENT_ORG_IDS: f.orgId,
        CONTAINER_BILLING_WARN_REMAINING_MICRODOLLARS: '10000000',
      } as unknown as Cloudflare.Env
    );
    try {
      await meter.recordStart({
        ...f.context,
        startEpochMs: f.start,
        idempotencyKey: startIdempotencyKey(f.context.service, f.context.instanceId, f.start),
      });
      clock.mockReturnValue(f.start + 300_000);
      await meter.recordHeartbeat(f.heartbeatInput);
      await Promise.all(pending);
      await meter.recordHeartbeat(f.heartbeatInput);
      await Promise.all(pending);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
      fetchMock.mockRestore();
    }
  });
});
