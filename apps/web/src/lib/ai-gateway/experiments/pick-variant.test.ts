import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createCallerForUser } from '@/routers/test-utils';
import { model_experiment, model_experiment_variant_version } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { isPublicIdExperimented } from './membership';
import { pickModelExperimentVariant } from './pick-variant';
import { redisClient } from '@/lib/redis';
import { EXPERIMENTED_PUBLIC_IDS_REDIS_KEY } from '@/lib/redis-keys';
import type { User } from '@kilocode/db/schema';

let admin: User;

const upstreamA = {
  internal_id: 'partner-checkpoint-a',
  base_url: 'https://partner.example.com/v1',
};
const upstreamB = {
  internal_id: 'partner-checkpoint-b',
  base_url: 'https://partner.example.com/v1',
};
const redisIt =
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? it : it.skip;

beforeEach(async () => {
  await cleanupDbForTest();
  admin = await insertTestUser({
    google_user_email: `admin-${Math.random()}@admin.example.com`,
    is_admin: true,
  });
});

async function clearRoutingCaches() {
  // Tests share the dev Redis instance across runs; flush the membership key
  // so each test sees a fresh load path.
  await redisClient.del(EXPERIMENTED_PUBLIC_IDS_REDIS_KEY);
}

async function seedExperimentedPublicIds(ids: string[]): Promise<string | null> {
  return await redisClient.set(EXPERIMENTED_PUBLIC_IDS_REDIS_KEY, JSON.stringify(ids));
}

afterEach(async () => {
  await redisClient.del(EXPERIMENTED_PUBLIC_IDS_REDIS_KEY);
});

async function makeActiveExperiment(opts: {
  publicId: string;
  weights?: [number, number];
  apiKeys?: [string, string];
}) {
  const { publicId, weights = [1, 1], apiKeys = ['sk-a', 'sk-b'] } = opts;
  const caller = await createCallerForUser(admin.id);
  const exp = await caller.admin.modelExperiments.create({
    public_model_id: publicId,
    name: `exp-${publicId}`,
  });
  const a = await caller.admin.modelExperiments.addVariant({
    id: exp.id,
    label: 'control',
    weight: weights[0],
  });
  const b = await caller.admin.modelExperiments.addVariant({
    id: exp.id,
    label: 'treatment',
    weight: weights[1],
  });
  await caller.admin.modelExperiments.swapVariantVersion({
    variantId: a.id,
    upstream: upstreamA,
    apiKey: apiKeys[0],
  });
  await caller.admin.modelExperiments.swapVariantVersion({
    variantId: b.id,
    upstream: upstreamB,
    apiKey: apiKeys[1],
  });
  await caller.admin.modelExperiments.activate({ id: exp.id });
  return { experimentId: exp.id, variantA: a.id, variantB: b.id };
}

describe('isPublicIdExperimented', () => {
  it('returns false for an unknown public id', async () => {
    await clearRoutingCaches();
    expect(await isPublicIdExperimented('partner/preview-not-experimented')).toBe(false);
  });

  redisIt('returns true when the public id has an active experiment', async () => {
    await makeActiveExperiment({ publicId: 'partner/preview-iset-active' });
    expect(await seedExperimentedPublicIds(['partner/preview-iset-active'])).toBe('OK');
    expect(await isPublicIdExperimented('partner/preview-iset-active')).toBe(true);
  });

  redisIt('returns true when the public id has only a paused experiment', async () => {
    const { experimentId } = await makeActiveExperiment({
      publicId: 'partner/preview-iset-paused',
    });
    const caller = await createCallerForUser(admin.id);
    await caller.admin.modelExperiments.pause({ id: experimentId });
    expect(await seedExperimentedPublicIds(['partner/preview-iset-paused'])).toBe('OK');
    expect(await isPublicIdExperimented('partner/preview-iset-paused')).toBe(true);
  });
});

describe('pickModelExperimentVariant', () => {
  it('returns null for a public id with no routing-relevant experiment', async () => {
    await clearRoutingCaches();
    const result = await pickModelExperimentVariant({
      publicModelId: 'partner/preview-pick-none',
      userId: 'user-1',
      machineId: null,
      clientIp: null,
    });
    expect(result).toBeNull();
  });

  it('produces stable assignments for the same userId', async () => {
    await makeActiveExperiment({ publicId: 'partner/preview-stable' });
    const first = await pickModelExperimentVariant({
      publicModelId: 'partner/preview-stable',
      userId: 'user-1',
      machineId: null,
      clientIp: null,
    });
    const second = await pickModelExperimentVariant({
      publicModelId: 'partner/preview-stable',
      userId: 'user-1',
      machineId: null,
      clientIp: null,
    });
    expect(first?.status).toBe('active');
    expect(second?.status).toBe('active');
    if (first?.status !== 'active' || second?.status !== 'active') return;
    expect(first.variantId).toBe(second.variantId);
    expect(first.variantVersionId).toBe(second.variantVersionId);
  });

  it('decrypts and returns the partner-issued api key for the chosen variant', async () => {
    const { variantA, variantB } = await makeActiveExperiment({
      publicId: 'partner/preview-key',
      apiKeys: ['sk-control-secret', 'sk-treatment-secret'],
    });
    const result = await pickModelExperimentVariant({
      publicModelId: 'partner/preview-key',
      userId: 'user-key',
      machineId: null,
      clientIp: null,
    });
    expect(result?.status).toBe('active');
    if (result?.status !== 'active') return;
    expect(result.upstream.api_key).toMatch(/^sk-(control|treatment)-secret$/);
    expect([variantA, variantB]).toContain(result.variantId);
  });

  it('respects allocation-subject precedence: user > machine > ip', async () => {
    await makeActiveExperiment({ publicId: 'partner/preview-alloc' });
    const userPick = await pickModelExperimentVariant({
      publicModelId: 'partner/preview-alloc',
      userId: 'user-z',
      machineId: 'machine-z',
      clientIp: '1.2.3.4',
    });
    const machinePick = await pickModelExperimentVariant({
      publicModelId: 'partner/preview-alloc',
      userId: null,
      machineId: 'machine-z',
      clientIp: '1.2.3.4',
    });
    const ipPick = await pickModelExperimentVariant({
      publicModelId: 'partner/preview-alloc',
      userId: null,
      machineId: null,
      clientIp: '1.2.3.4',
    });
    expect(userPick?.status).toBe('active');
    expect(machinePick?.status).toBe('active');
    expect(ipPick?.status).toBe('active');
    if (userPick?.status !== 'active') return;
    if (machinePick?.status !== 'active') return;
    if (ipPick?.status !== 'active') return;
    expect(userPick.allocationSubject).toBe('user');
    expect(machinePick.allocationSubject).toBe('machine');
    expect(ipPick.allocationSubject).toBe('ip');
  });

  it('returns unavailable when no allocation subject is available', async () => {
    await makeActiveExperiment({ publicId: 'partner/preview-noalloc' });
    const result = await pickModelExperimentVariant({
      publicModelId: 'partner/preview-noalloc',
      userId: null,
      machineId: null,
      clientIp: null,
    });
    expect(result?.status).toBe('unavailable');
  });

  it('returns not-found for a paused experiment so traffic does not silently fall through', async () => {
    const { experimentId } = await makeActiveExperiment({ publicId: 'partner/preview-paused' });
    const caller = await createCallerForUser(admin.id);
    await caller.admin.modelExperiments.pause({ id: experimentId });
    await clearRoutingCaches();
    const result = await pickModelExperimentVariant({
      publicModelId: 'partner/preview-paused',
      userId: 'user-q',
      machineId: null,
      clientIp: null,
    });
    expect(result?.status).toBe('not-found');
  });

  it('hot-swap: serves the new variant_version_id but keeps the same bucket', async () => {
    const { experimentId, variantA, variantB } = await makeActiveExperiment({
      publicId: 'partner/preview-hotswap',
    });
    const caller = await createCallerForUser(admin.id);
    const before = await pickModelExperimentVariant({
      publicModelId: 'partner/preview-hotswap',
      userId: 'user-pinned',
      machineId: null,
      clientIp: null,
    });
    expect(before?.status).toBe('active');
    if (before?.status !== 'active') return;

    // Hot-swap whichever variant the user landed on with a new RC.
    await caller.admin.modelExperiments.swapVariantVersion({
      variantId: before.variantId,
      upstream: { ...upstreamA, internal_id: 'partner-checkpoint-rc-next' },
      apiKey: 'sk-rc-next',
    });
    await clearRoutingCaches();

    const after = await pickModelExperimentVariant({
      publicModelId: 'partner/preview-hotswap',
      userId: 'user-pinned',
      machineId: null,
      clientIp: null,
    });
    expect(after?.status).toBe('active');
    if (after?.status !== 'active') return;
    // Same slot (variantId), new RC (variantVersionId), new internal_id.
    expect(after.variantId).toBe(before.variantId);
    expect(after.variantVersionId).not.toBe(before.variantVersionId);
    expect(after.upstream.internal_id).toBe('partner-checkpoint-rc-next');
    expect(after.upstream.api_key).toBe('sk-rc-next');
    // sanity: experiment + slots unchanged
    expect([variantA, variantB]).toContain(after.variantId);
    expect(experimentId).toBeTruthy();
  });

  it('weighted distribution lands roughly on configured weights', async () => {
    // 1:3 split. With 200 distinct seeds, control should be near 25%.
    await makeActiveExperiment({
      publicId: 'partner/preview-weighted',
      weights: [1, 3],
    });
    const counts = { control: 0, treatment: 0 };
    for (let i = 0; i < 200; i++) {
      const r = await pickModelExperimentVariant({
        publicModelId: 'partner/preview-weighted',
        userId: `user-${i}`,
        machineId: null,
        clientIp: null,
      });
      if (r?.status !== 'active') throw new Error('expected active');
      if (r.upstream.internal_id === upstreamA.internal_id) counts.control++;
      else counts.treatment++;
    }
    // Loose bounds: 1:3 ≈ 25/75. Allow ±10pp for n=200.
    const controlPct = counts.control / 200;
    expect(controlPct).toBeGreaterThan(0.15);
    expect(controlPct).toBeLessThanOrEqual(0.35);
  });

  it('historical attribution survives hot-swap: old variant_version_id still resolves to old upstream via DB', async () => {
    const { experimentId } = await makeActiveExperiment({
      publicId: 'partner/preview-attr',
    });
    const before = await pickModelExperimentVariant({
      publicModelId: 'partner/preview-attr',
      userId: 'user-attr',
      machineId: null,
      clientIp: null,
    });
    expect(before?.status).toBe('active');
    if (before?.status !== 'active') return;

    const oldVersionId = before.variantVersionId;
    const oldInternalId = before.upstream.internal_id;

    const caller = await createCallerForUser(admin.id);
    await caller.admin.modelExperiments.swapVariantVersion({
      variantId: before.variantId,
      upstream: { ...upstreamA, internal_id: 'rc-newer' },
      apiKey: 'sk-newer',
    });

    // Old version row is still in the DB and still points at the old
    // upstream — `model_experiment_request` rows that referenced
    // `oldVersionId` remain attributable to the original RC.
    const [row] = await db
      .select()
      .from(model_experiment_variant_version)
      .where(eq(model_experiment_variant_version.id, oldVersionId));
    expect(row).toBeDefined();
    const oldUpstream = row.upstream as { internal_id: string };
    expect(oldUpstream.internal_id).toBe(oldInternalId);
    expect(experimentId).toBeTruthy();
  });

  it('completed experiments are not returned by the picker (status none after completion)', async () => {
    const { experimentId } = await makeActiveExperiment({
      publicId: 'partner/preview-completed',
    });
    const caller = await createCallerForUser(admin.id);
    await caller.admin.modelExperiments.complete({ id: experimentId });
    await clearRoutingCaches();
    const result = await pickModelExperimentVariant({
      publicModelId: 'partner/preview-completed',
      userId: 'user-c',
      machineId: null,
      clientIp: null,
    });
    expect(result).toBeNull();
    // sanity: row still exists, just not routing-relevant
    const [row] = await db
      .select()
      .from(model_experiment)
      .where(eq(model_experiment.id, experimentId));
    expect(row.status).toBe('completed');
  });
});
