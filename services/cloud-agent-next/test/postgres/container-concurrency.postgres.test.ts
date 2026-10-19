import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDrizzleClient, getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import {
  cloud_billing_sku,
  container_usage_interval,
  kilocode_users,
  organizations,
  type NewContainerUsageInterval,
} from '@kilocode/db/schema';
import { eq, inArray } from 'drizzle-orm';
import {
  assertContainerCapacity,
  readContainerCapacity,
  type ContainerCapacityRequest,
} from '../../src/container-concurrency.js';
import type { Env } from '../../src/types.js';

const userId = `oauth/test-container-capacity:${randomUUID()}`;
const organizationIds = [randomUUID(), randomUUID()];
const skuId = `capacity-test-${randomUUID()}`;
let reader: WorkerDb;
let writer: ReturnType<typeof createDrizzleClient>;

function request(
  subject: ContainerCapacityRequest['subject'] = { type: 'user', id: userId }
): ContainerCapacityRequest {
  return {
    subject,
    actor: { type: 'user', id: userId },
    instanceId: 'ses-capacity-restart',
    checkpoint: 'control-plane-create',
  };
}

function organizationRequest(index = 0): ContainerCapacityRequest {
  return request({ type: 'org', id: organizationIds[index] });
}

async function interval(overrides: Partial<NewContainerUsageInterval> = {}): Promise<void> {
  await writer.db.insert(container_usage_interval).values({
    id: randomUUID(),
    service: 'cloud-agent-next-sandbox',
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
  });
}

function assertCapacity(input: ContainerCapacityRequest): Promise<void> {
  return assertContainerCapacity({} as Pick<Env, 'HYPERDRIVE'>, input, {
    readCapacity: current => readContainerCapacity(reader, current),
  });
}

beforeAll(async () => {
  const connectionString = process.env.POSTGRES_URL;
  if (!connectionString) throw new Error('Set POSTGRES_URL to a migrated test database');
  reader = getWorkerDb(connectionString);
  writer = createDrizzleClient({ connectionString, ssl: false });
  await writer.db.insert(kilocode_users).values({
    id: userId,
    google_user_email: `capacity-${randomUUID()}@example.test`,
    google_user_name: 'Container capacity fixture',
    google_user_image_url: '',
    stripe_customer_id: '',
  });
  await writer.db
    .insert(organizations)
    .values(organizationIds.map(id => ({ id, name: 'Container capacity fixture' })));
  await writer.db.insert(cloud_billing_sku).values({
    id: skuId,
    name: 'Container capacity fixture',
    unit: 'second',
    rate_cents_per_unit: '0.01',
  });
});

afterEach(async () => {
  await writer.db
    .delete(container_usage_interval)
    .where(eq(container_usage_interval.cloud_billing_sku_id, skuId));
  await writer.db
    .update(kilocode_users)
    .set({ total_microdollars_acquired: 0, microdollars_used: 0, inference_microdollars_held: 0 })
    .where(eq(kilocode_users.id, userId));
  await writer.db
    .update(organizations)
    .set({ total_microdollars_acquired: 0, microdollars_used: 0, inference_microdollars_held: 0 })
    .where(inArray(organizations.id, organizationIds));
});

afterAll(async () => {
  await writer.db.delete(cloud_billing_sku).where(eq(cloud_billing_sku.id, skuId));
  await writer.db.delete(organizations).where(inArray(organizations.id, organizationIds));
  await writer.db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  await writer.pool.end();
  const readerPool = (reader as unknown as { $client?: { end: () => Promise<void> } }).$client;
  await readerPool?.end();
});

describe('container capacity against PostgreSQL', () => {
  it.each([
    [-1, 3],
    [0, 3],
    [2_999_999, 3],
    [3_000_000, 20],
    [3_000_001, 20],
  ])('uses remaining personal balance %i microdollars for limit %i', async (balance, limit) => {
    await writer.db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: 4_000_000, microdollars_used: 4_000_000 - balance })
      .where(eq(kilocode_users.id, userId));
    expect(await readContainerCapacity(reader, request())).toEqual([
      { subject: { type: 'user', id: userId }, live: 0, limit },
    ]);
  });

  it('uses the low-balance limit when the remaining balance is fully held', async () => {
    await writer.db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: 10_000_000, inference_microdollars_held: 10_000_000 })
      .where(eq(kilocode_users.id, userId));
    expect(await readContainerCapacity(reader, request())).toEqual([
      { subject: { type: 'user', id: userId }, live: 0, limit: 3 },
    ]);
  });

  it('uses organization balance for a member with zero personal balance', async () => {
    await writer.db
      .update(organizations)
      .set({ total_microdollars_acquired: 5_000_000, microdollars_used: 2_000_000 })
      .where(eq(organizations.id, organizationIds[0]));
    expect(await readContainerCapacity(reader, organizationRequest())).toEqual([
      { subject: { type: 'user', id: userId }, live: 0, limit: 20 },
      { subject: { type: 'org', id: organizationIds[0] }, live: 0, limit: 50 },
    ]);
    // A funded organization does not raise the allowance for personal starts
    // or starts billed to another, unfunded organization.
    expect((await readContainerCapacity(reader, request()))[0].limit).toBe(3);
    expect((await readContainerCapacity(reader, organizationRequest(1)))[0].limit).toBe(3);
  });

  it('does not let personal credit raise an unfunded organization allowance', async () => {
    await writer.db
      .update(kilocode_users)
      .set({ total_microdollars_acquired: 10_000_000 })
      .where(eq(kilocode_users.id, userId));
    expect((await readContainerCapacity(reader, organizationRequest()))[0].limit).toBe(3);
  });

  it('rejects the fourth low-balance start across personal and two organization accounts', async () => {
    await interval();
    for (const id of organizationIds) await interval({ subject_type: 'org', subject_id: id });

    expect(await readContainerCapacity(reader, organizationRequest())).toEqual([
      { subject: { type: 'user', id: userId }, live: 3, limit: 3 },
      { subject: { type: 'org', id: organizationIds[0] }, live: 1, limit: 50 },
    ]);
    await expect(assertCapacity(organizationRequest())).rejects.toMatchObject({ limit: 3 });
    await expect(assertCapacity(request())).rejects.toMatchObject({ limit: 3 });
  });

  it('rejects the twenty-first funded start even when the destination organization is empty', async () => {
    await writer.db
      .update(organizations)
      .set({ total_microdollars_acquired: 3_000_000 })
      .where(eq(organizations.id, organizationIds[1]));
    await interval();
    for (let index = 1; index < 20; index += 1) {
      await interval({ subject_type: 'org', subject_id: organizationIds[0] });
    }
    expect(await readContainerCapacity(reader, organizationRequest(1))).toEqual([
      { subject: { type: 'user', id: userId }, live: 20, limit: 20 },
      { subject: { type: 'org', id: organizationIds[1] }, live: 0, limit: 50 },
    ]);
    await expect(assertCapacity(organizationRequest(1))).rejects.toMatchObject({ limit: 20 });
  });

  it('excludes stale, closed, code-review, unrelated and restarting containers from the user count', async () => {
    await interval();
    await interval({ subject_type: 'org', subject_id: organizationIds[0] });
    await interval({ subject_type: 'org', subject_id: organizationIds[1] });
    await interval({ service: 'other-service' });
    await interval({ service: 'cloud-agent-next-code-review' });
    await interval({ instance_id: `crv-${randomUUID()}` });
    await interval({ metadata: { origin: 'code-review' } });
    await interval({ instance_id: request().instanceId });
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

    expect(await readContainerCapacity(reader, organizationRequest())).toEqual([
      { subject: { type: 'user', id: userId }, live: 3, limit: 3 },
      { subject: { type: 'org', id: organizationIds[0] }, live: 3, limit: 50 },
    ]);
  });

  it('retains subject limits for bots without treating bot IDs as users', async () => {
    const actor = { type: 'bot', id: 'auto-triage' } as const;
    await interval({ actor_type: 'bot', actor_id: actor.id });
    expect(await readContainerCapacity(reader, { ...request(), actor })).toEqual([
      { subject: { type: 'user', id: userId }, live: 1, limit: 20 },
    ]);
    expect(await readContainerCapacity(reader, { ...organizationRequest(), actor })).toEqual([
      { subject: { type: 'org', id: organizationIds[0] }, live: 0, limit: 50 },
    ]);
  });
});
