import { beforeEach, describe, expect, it } from '@jest/globals';
import { kiloclaw_instances } from '@kilocode/db/schema';

import { cleanupDbForTest, db } from '@/lib/drizzle';
import { insertTestUser } from '@/tests/helpers/user.helper';

import { userIsWithinFirstKiloClawInstanceWindow } from './setup-promo';

const HOUR_MS = 60 * 60 * 1000;

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * HOUR_MS).toISOString();
}

async function insertInstance(params: {
  userId: string;
  createdAt: string;
  destroyedAt?: string | null;
  sandboxSuffix?: string;
}) {
  const id = crypto.randomUUID();
  await db.insert(kiloclaw_instances).values({
    id,
    user_id: params.userId,
    sandbox_id: `sb_${id.replaceAll('-', '')}${params.sandboxSuffix ?? ''}`,
    created_at: params.createdAt,
    destroyed_at: params.destroyedAt ?? null,
  });
  return id;
}

describe('userIsWithinFirstKiloClawInstanceWindow', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('returns false when the user has no instances', async () => {
    const user = await insertTestUser();

    const eligible = await userIsWithinFirstKiloClawInstanceWindow({ userId: user.id });

    expect(eligible).toBe(false);
  });

  it('returns true for a single active instance created inside the window', async () => {
    const user = await insertTestUser();
    await insertInstance({ userId: user.id, createdAt: hoursAgo(0.5) });

    const eligible = await userIsWithinFirstKiloClawInstanceWindow({ userId: user.id });

    expect(eligible).toBe(true);
  });

  it('returns false for a single active instance created outside the window', async () => {
    const user = await insertTestUser();
    await insertInstance({ userId: user.id, createdAt: hoursAgo(3) });

    const eligible = await userIsWithinFirstKiloClawInstanceWindow({ userId: user.id });

    expect(eligible).toBe(false);
  });

  it('returns false when oldest instance is outside the window even if newest is fresh', async () => {
    // Core "first instance" semantic: a returning user creating a new instance
    // today is NOT eligible because their FIRST instance is old.
    const user = await insertTestUser();
    await insertInstance({
      userId: user.id,
      createdAt: hoursAgo(48),
      sandboxSuffix: '_old',
    });
    await insertInstance({
      userId: user.id,
      createdAt: hoursAgo(0.25),
      sandboxSuffix: '_new',
    });

    const eligible = await userIsWithinFirstKiloClawInstanceWindow({ userId: user.id });

    expect(eligible).toBe(false);
  });

  it('returns true when all instances are inside the window', async () => {
    const user = await insertTestUser();
    await insertInstance({
      userId: user.id,
      createdAt: hoursAgo(1.5),
      sandboxSuffix: '_a',
    });
    await insertInstance({
      userId: user.id,
      createdAt: hoursAgo(0.1),
      sandboxSuffix: '_b',
    });

    const eligible = await userIsWithinFirstKiloClawInstanceWindow({ userId: user.id });

    expect(eligible).toBe(true);
  });

  it('counts destroyed instances when computing the first-instance timestamp', async () => {
    // Destroyed instances must still count: otherwise a user could destroy their
    // first instance and re-qualify for the setup-promo window indefinitely.
    const user = await insertTestUser();
    await insertInstance({
      userId: user.id,
      createdAt: hoursAgo(48),
      destroyedAt: hoursAgo(40),
      sandboxSuffix: '_destroyed_old',
    });
    await insertInstance({
      userId: user.id,
      createdAt: hoursAgo(0.25),
      sandboxSuffix: '_active_new',
    });

    const eligible = await userIsWithinFirstKiloClawInstanceWindow({ userId: user.id });

    expect(eligible).toBe(false);
  });

  it('returns true when only a single destroyed instance exists and it is inside the window', async () => {
    const user = await insertTestUser();
    await insertInstance({
      userId: user.id,
      createdAt: hoursAgo(0.5),
      destroyedAt: hoursAgo(0.1),
    });

    const eligible = await userIsWithinFirstKiloClawInstanceWindow({ userId: user.id });

    expect(eligible).toBe(true);
  });

  it('honors a custom maxAgeHours', async () => {
    const user = await insertTestUser();
    await insertInstance({ userId: user.id, createdAt: hoursAgo(5) });

    expect(await userIsWithinFirstKiloClawInstanceWindow({ userId: user.id, maxAgeHours: 2 })).toBe(
      false
    );
    expect(await userIsWithinFirstKiloClawInstanceWindow({ userId: user.id, maxAgeHours: 8 })).toBe(
      true
    );
  });

  it('does not see other users instances', async () => {
    const target = await insertTestUser();
    const other = await insertTestUser();
    await insertInstance({ userId: other.id, createdAt: hoursAgo(0.1) });

    const eligible = await userIsWithinFirstKiloClawInstanceWindow({ userId: target.id });

    expect(eligible).toBe(false);
  });

  it('does not let other users instances rescue an outside-window user', async () => {
    const target = await insertTestUser();
    const other = await insertTestUser();
    await insertInstance({
      userId: target.id,
      createdAt: hoursAgo(48),
      sandboxSuffix: '_target_old',
    });
    await insertInstance({
      userId: other.id,
      createdAt: hoursAgo(0.1),
      sandboxSuffix: '_other_new',
    });

    const eligible = await userIsWithinFirstKiloClawInstanceWindow({ userId: target.id });

    expect(eligible).toBe(false);
  });
});
