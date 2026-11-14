import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient } from '@kilocode/db/client';
import {
  cloud_billing_sku,
  container_usage_interval,
  kilocode_users,
  organizations,
  type NewContainerUsageInterval,
} from '@kilocode/db/schema';
import {
  intervalId,
  startIdempotencyKey,
  usageContextFingerprint,
  type RecordStartInput,
} from '@kilocode/container-usage';
import { eq, inArray, sql } from 'drizzle-orm';
import { applyStartWithDb } from '../src/postgres';

const connectionString =
  process.env.POSTGRES_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
const SERVICE = 'cloud-agent-next-sandbox';
const userId = `oauth/test-container-capacity:${randomUUID()}`;
const organizationIds = [randomUUID(), randomUUID()];
const skuId = `capacity-test-${randomUUID()}`;
let client: ReturnType<typeof createDrizzleClient>;

type StartOverrides = Partial<Omit<RecordStartInput, 'service' | 'idempotencyKey' | 'sku'>>;

function startInput(overrides: StartOverrides = {}): RecordStartInput {
  const instanceId = overrides.instanceId ?? `ses-${randomUUID()}`;
  const startEpochMs = overrides.startEpochMs ?? Date.now();
  return {
    service: SERVICE,
    sku: skuId,
    subject: { type: 'user', id: userId },
    actor: { type: 'user', id: userId },
    enforceCapacity: true,
    ...overrides,
    instanceId,
    startEpochMs,
    idempotencyKey: startIdempotencyKey(SERVICE, instanceId, startEpochMs),
  };
}

async function start(input: RecordStartInput) {
  const { service, instanceId, sku, subject, actor, onBehalfOf, sessionId, metadata } = input;
  return applyStartWithDb(
    client.db,
    input,
    intervalId(service, instanceId, input.startEpochMs),
    await usageContextFingerprint({
      service,
      instanceId,
      sku,
      subject,
      actor,
      onBehalfOf,
      sessionId,
      metadata,
    }),
    Date.now()
  );
}

function organizationStart(index = 0, overrides: StartOverrides = {}): RecordStartInput {
  return startInput({ subject: { type: 'org', id: organizationIds[index] }, ...overrides });
}

function intervalRow(overrides: Partial<NewContainerUsageInterval> = {}) {
  return {
    id: randomUUID(),
    service: SERVICE,
    instance_id: `ses-${randomUUID()}`,
    start_epoch_ms: Date.now() - 60_000,
    cloud_billing_sku_id: skuId,
    context_fingerprint: 'a'.repeat(64),
    subject_type: 'user',
    subject_id: userId,
    actor_type: 'user',
    actor_id: userId,
    started_at: new Date(Date.now() - 60_000).toISOString(),
    last_seen_at: new Date().toISOString(),
    ...overrides,
  } satisfies NewContainerUsageInterval;
}

async function interval(overrides: Partial<NewContainerUsageInterval> = {}): Promise<void> {
  await client.db.insert(container_usage_interval).values(intervalRow(overrides));
}

async function intervals(total: number, overrides: Partial<NewContainerUsageInterval> = {}) {
  for (let index = 0; index < total; index += 1) await interval(overrides);
}

async function setPersonalBalance(balance: number): Promise<void> {
  await client.db
    .update(kilocode_users)
    .set({ total_microdollars_acquired: 4_000_000, microdollars_used: 4_000_000 - balance })
    .where(eq(kilocode_users.id, userId));
}

function limitRejection(limit: number, account: 'user' | 'organization' = 'user') {
  return {
    kind: 'rejected',
    code: 'container_limit_reached',
    message: `container_limit_reached: The ${account} has reached its limit of ${limit} concurrent containers. Stop an existing container before starting another.`,
  };
}

const admitted = { kind: 'applied', dedup: false, billingMode: 'shadow' };

beforeAll(async () => {
  client = createDrizzleClient({ connectionString, ssl: false });
  await client.db.insert(kilocode_users).values({
    id: userId,
    google_user_email: `capacity-${randomUUID()}@example.test`,
    google_user_name: 'Container capacity fixture',
    google_user_image_url: '',
    stripe_customer_id: '',
  });
  await client.db
    .insert(organizations)
    .values(organizationIds.map(id => ({ id, name: 'Container capacity fixture' })));
  await client.db.insert(cloud_billing_sku).values({
    id: skuId,
    name: 'Container capacity fixture',
    unit: 'second',
    rate_cents_per_unit: '0.01',
  });
});

afterEach(async () => {
  await client.db
    .delete(container_usage_interval)
    .where(eq(container_usage_interval.cloud_billing_sku_id, skuId));
  await setPersonalBalance(0);
  await client.db
    .update(organizations)
    .set({ total_microdollars_acquired: 0, microdollars_used: 0 })
    .where(inArray(organizations.id, organizationIds));
});

afterAll(async () => {
  await client.db.delete(cloud_billing_sku).where(eq(cloud_billing_sku.id, skuId));
  await client.db.delete(organizations).where(inArray(organizations.id, organizationIds));
  await client.db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  await client.pool.end();
});

describe('container capacity admission against PostgreSQL', () => {
  it.each([
    [-1, 3],
    [0, 3],
    [2_999_999, 3],
    [3_000_000, 20],
  ])('admits up to the limit for personal balance %i microdollars (%i)', async (balance, limit) => {
    await setPersonalBalance(balance);
    await intervals(limit - 1);
    await expect(start(startInput())).resolves.toEqual(admitted);
    await expect(start(startInput())).resolves.toEqual(limitRejection(limit));
  });

  it('uses the billed organization balance for the user cap', async () => {
    await client.db
      .update(organizations)
      .set({ total_microdollars_acquired: 5_000_000, microdollars_used: 2_000_000 })
      .where(eq(organizations.id, organizationIds[0]));
    await intervals(3);
    await expect(start(organizationStart(0))).resolves.toEqual(admitted);
    // A funded organization does not raise the cap for personal starts or for
    // starts billed to another, unfunded organization.
    await expect(start(startInput())).resolves.toEqual(limitRejection(3));
    await expect(start(organizationStart(1))).resolves.toEqual(limitRejection(3));
  });

  it('does not let personal credit raise the cap of an unfunded organization', async () => {
    await setPersonalBalance(10_000_000);
    await intervals(3);
    await expect(start(organizationStart(0))).resolves.toEqual(limitRejection(3));
  });

  it('applies the organization cap across its members', async () => {
    await intervals(50, {
      subject_type: 'org',
      subject_id: organizationIds[0],
      actor_id: 'other-user',
    });
    await expect(start(organizationStart(0))).resolves.toEqual(limitRejection(50, 'organization'));
  });

  it('excludes stale, closed, code-review, unrelated and restarting containers', async () => {
    const restarting = `ses-${randomUUID()}`;
    await interval();
    await interval({ subject_type: 'org', subject_id: organizationIds[0] });
    await interval({ service: 'other-service' });
    await interval({ service: 'cloud-agent-next-code-review' });
    await interval({ instance_id: `crv-${randomUUID()}` });
    await interval({ metadata: { origin: 'code-review' } });
    await interval({ instance_id: restarting });
    await interval({
      started_at: new Date(Date.now() - 13 * 60_000).toISOString(),
      last_seen_at: new Date(Date.now() - 12 * 60_000).toISOString(),
    });
    await interval({
      status: 'closed',
      stopped_at: new Date().toISOString(),
      close_reason: 'exit',
    });
    await interval({ subject_type: 'org', subject_id: organizationIds[0], actor_id: 'other-user' });
    // A bot with the same ID must not count as this user.
    await interval({ subject_type: 'org', subject_id: organizationIds[0], actor_type: 'bot' });

    await expect(start(startInput({ instanceId: restarting }))).resolves.toEqual(admitted);
    await expect(start(startInput())).resolves.toEqual(limitRejection(3));
  });

  it('keeps the billing account cap for a bot without counting it as a user', async () => {
    const actor = { type: 'bot', id: 'code-review-bot' } as const;
    await intervals(19, { actor_type: 'bot', actor_id: actor.id });
    const onBehalfOf = { type: 'user', id: userId } as const;
    await expect(start(startInput({ actor, onBehalfOf }))).resolves.toEqual(admitted);
    await expect(start(startInput({ actor, onBehalfOf }))).resolves.toEqual(limitRejection(20));
  });

  it('admits exempt code-review starts and unmarked starts at the limit', async () => {
    await intervals(3);
    await expect(start(startInput({ metadata: { origin: 'code-review' } }))).resolves.toEqual(
      admitted
    );
    await expect(start(startInput({ instanceId: `crv-${randomUUID()}` }))).resolves.toEqual(
      admitted
    );
    await expect(start(startInput({ enforceCapacity: undefined }))).resolves.toEqual(admitted);
  });

  it('replays an admitted start after the subject reaches the limit', async () => {
    await intervals(2);
    const first = startInput();
    await expect(start(first)).resolves.toEqual(admitted);
    await expect(start(startInput())).resolves.toEqual(limitRejection(3));
    await expect(start(first)).resolves.toEqual({ ...admitted, dedup: true });
  });

  it('counts an interval committed while the start waited for the capacity lock', async () => {
    await intervals(2);
    let lockHeld = (): void => undefined;
    let release = (): void => undefined;
    const held = new Promise<void>(resolve => {
      lockHeld = resolve;
    });
    const released = new Promise<void>(resolve => {
      release = resolve;
    });
    // A concurrent admission for the same user holds the lock and opens the last slot.
    const blocker = client.db.transaction(async tx => {
      const key = `container-capacity:user:${userId}`;
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
      await tx.insert(container_usage_interval).values(intervalRow());
      lockHeld();
      await released;
    });
    await held;

    const contender = start(startInput());
    await expect
      .poll(async () => {
        const result = await client.pool.query<{ count: string }>(
          `SELECT count(*) FROM pg_stat_activity
            WHERE datname = current_database()
              AND wait_event_type = 'Lock'
              AND wait_event = 'advisory'`
        );
        return Number(result.rows[0]?.count ?? 0);
      })
      .toBeGreaterThan(0);
    release();
    await blocker;

    await expect(contender).resolves.toEqual(limitRejection(3));
  });
});
