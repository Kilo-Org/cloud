import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDrizzleClient, getWorkerDb, type WorkerDb } from '@kilocode/db/client';
import { cloud_billing_sku, container_usage_interval } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { usageServiceForSandboxClass } from '../../src/container-usage-context.js';
import { countOpenSmallSandboxContainers } from '../../src/interactive-sandbox-capacity.js';

const connectionString = process.env.POSTGRES_URL;
if (!connectionString) {
  throw new Error('Set POSTGRES_URL to a migrated test database before running this suite');
}

const suffix = randomUUID();
const skuId = `interactive-sandbox-capacity-${suffix}`;
const userId = `capacity-user-${suffix}`;
const otherUserId = `capacity-other-${suffix}`;
const organizationId = randomUUID();
const openSmallService = usageServiceForSandboxClass('SandboxSmall');
const openSmallContainmentService = usageServiceForSandboxClass('SandboxSmallContainment');
const timestamp = new Date('2026-02-01T00:00:00.000Z').toISOString();

let reader: WorkerDb;
let writer: ReturnType<typeof createDrizzleClient>;

type IntervalOverrides = Partial<typeof container_usage_interval.$inferInsert>;

async function insertInterval(overrides: IntervalOverrides = {}): Promise<void> {
  await writer.db.insert(container_usage_interval).values({
    id: `interval-${randomUUID()}`,
    service: openSmallService,
    instance_id: `instance-${randomUUID()}`,
    start_epoch_ms: 1_000,
    cloud_billing_sku_id: skuId,
    context_fingerprint: 'a'.repeat(64),
    subject_type: 'user',
    subject_id: userId,
    actor_type: 'user',
    actor_id: userId,
    started_at: timestamp,
    last_seen_at: timestamp,
    status: 'open',
    ...overrides,
  });
}

beforeAll(async () => {
  reader = getWorkerDb(connectionString);
  writer = createDrizzleClient({ connectionString, ssl: false });
  await writer.db.insert(cloud_billing_sku).values({
    id: skuId,
    name: 'Interactive sandbox capacity test',
    unit: 'second',
    rate_cents_per_unit: '0.000001',
  });
});

beforeEach(async () => {
  await writer.db
    .delete(container_usage_interval)
    .where(eq(container_usage_interval.cloud_billing_sku_id, skuId));
});

afterAll(async () => {
  await writer.db
    .delete(container_usage_interval)
    .where(eq(container_usage_interval.cloud_billing_sku_id, skuId));
  await writer.db.delete(cloud_billing_sku).where(eq(cloud_billing_sku.id, skuId));
  await writer.pool.end();
  const readerPool = (reader as unknown as { $client?: { end: () => Promise<void> } }).$client;
  await readerPool?.end();
});

describe('countOpenSmallSandboxContainers', () => {
  it('counts both small services for the user actor, including an org subject', async () => {
    await insertInterval();
    await insertInterval({
      service: openSmallContainmentService,
      subject_type: 'org',
      subject_id: organizationId,
      actor_type: 'user',
      actor_id: userId,
    });

    expect(await countOpenSmallSandboxContainers(reader, userId)).toBe(2);
  });

  it('ignores closed intervals', async () => {
    await insertInterval();
    await insertInterval({
      status: 'closed',
      stopped_at: timestamp,
      close_reason: 'exit',
    });

    expect(await countOpenSmallSandboxContainers(reader, userId)).toBe(1);
  });

  it('ignores bot actors', async () => {
    await insertInterval();
    await insertInterval({
      actor_type: 'bot',
      actor_id: `bot-${suffix}`,
      subject_type: 'user',
      subject_id: userId,
    });
    // Actor id equal to the queried user: only the actor_type predicate can
    // exclude this row, so the test isolates it from an actor_id-only query.
    await insertInterval({
      actor_type: 'bot',
      actor_id: userId,
      subject_type: 'user',
      subject_id: userId,
    });

    expect(await countOpenSmallSandboxContainers(reader, userId)).toBe(1);
  });

  it('ignores other users', async () => {
    await insertInterval();
    await insertInterval({ subject_id: otherUserId, actor_id: otherUserId });

    expect(await countOpenSmallSandboxContainers(reader, userId)).toBe(1);
  });

  it('ignores non-small services', async () => {
    await insertInterval();
    await insertInterval({ service: usageServiceForSandboxClass('Sandbox') });

    expect(await countOpenSmallSandboxContainers(reader, userId)).toBe(1);
  });

  it('returns zero when the user has no open small intervals', async () => {
    expect(await countOpenSmallSandboxContainers(reader, userId)).toBe(0);
  });
});
