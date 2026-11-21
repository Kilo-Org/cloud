/**
 * An alias promotion writes the concrete target a shared measurement proved into every pool that
 * still holds the alias, together with the moved stable target. These tests run against a real
 * PostgreSQL: they seed pools across owners and base routers, drive the promotion through a fake
 * Worker reply, and keep another transaction open to prove the lock ordering.
 */
import { afterAll, beforeEach, describe, expect, it } from '@jest/globals';
import { eq, inArray } from 'drizzle-orm';
import {
  ai_gateway_config,
  auto_routing_custom_routers,
  kilocode_users,
} from '@kilocode/db/schema';
import type { CustomRouterEntry } from '@kilocode/auto-routing-contracts';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

const mockAcquire = jest.fn<Promise<unknown>, [request: unknown]>();
const mockRelease = jest.fn<Promise<unknown>, [request: unknown]>();

jest.mock('@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client', () => ({
  acquireAliasPromotion: (request: unknown) => mockAcquire(request),
  releaseAliasPromotion: (request: unknown) => mockRelease(request),
}));

import { lockAliasPromotionWrite } from '@/lib/auto-routing-custom-routers';
import { promoteAliasTargets } from '@/lib/providers/openrouter/sync-alias-pins';

const ALIAS = '~vendor/latest';
const OTHER_ALIAS = '~vendor/other-latest';
const OLD = 'vendor/old';
const NEW = 'vendor/new';
const OTHER_OLD = 'vendor/other-old';
const OTHER_NEW = 'vendor/other-new';

const userIds: string[] = [];

function gateway(model: string): CustomRouterEntry {
  return { kind: 'gateway', model };
}

function observed(model: string, pinnedAt = '2026-11-20T00:00:00.000Z') {
  return { model, pinnedAt, source: 'observed' as const };
}

function confirmed(model: string, confirmedAt = '2026-11-20T00:00:00.000Z') {
  return {
    model,
    pinnedAt: confirmedAt,
    requestId: '3f7c1f24-6b52-4f1f-9a0b-1f0f8f0c1a2b',
    confirmedAt,
  };
}

async function seedPool(params: {
  userId: string;
  slug: string;
  baseRouter?: 'efficient' | 'frontier';
  entries: CustomRouterEntry[];
}): Promise<string> {
  const [row] = await db
    .insert(auto_routing_custom_routers)
    .values({
      owned_by_user_id: params.userId,
      created_by_user_id: params.userId,
      slug: params.slug,
      name: params.slug,
      base_router: params.baseRouter ?? 'efficient',
      mode: 'cost_per_accuracy',
      entries: params.entries,
      default_entry_key: `gateway:${params.entries[0]?.kind === 'gateway' ? params.entries[0].model : ''}`,
    })
    .returning({ id: auto_routing_custom_routers.id });
  if (!row) throw new Error('Failed to seed a pool');
  return row.id;
}

async function entriesOf(poolId: string): Promise<CustomRouterEntry[]> {
  const [row] = await db
    .select({ entries: auto_routing_custom_routers.entries })
    .from(auto_routing_custom_routers)
    .where(eq(auto_routing_custom_routers.id, poolId));
  if (!row) throw new Error('Pool disappeared');
  return row.entries;
}

async function updatedAtOf(poolId: string): Promise<string> {
  const [row] = await db
    .select({ updated_at: auto_routing_custom_routers.updated_at })
    .from(auto_routing_custom_routers)
    .where(eq(auto_routing_custom_routers.id, poolId));
  if (!row) throw new Error('Pool disappeared');
  return row.updated_at;
}

async function storeTargets(aliases: { alias: string; target: string }[]) {
  await db
    .insert(ai_gateway_config)
    .values({ id: 1, latest_alias_targets: { aliases } })
    .onConflictDoUpdate({
      target: ai_gateway_config.id,
      set: { latest_alias_targets: { aliases } },
    });
}

async function readTargets(): Promise<{ alias: string; target: string }[]> {
  const [row] = await db
    .select({ config: ai_gateway_config.latest_alias_targets })
    .from(ai_gateway_config)
    .where(eq(ai_gateway_config.id, 1));
  return row?.config?.aliases ?? [];
}

function previousFrom(aliases: { alias: string; target: string }[]) {
  return new Map(aliases.map(entry => [entry.alias, entry] as const));
}

function held(ready: { router: string; model: string }[], leaseUntil = Date.now() + 60_000) {
  return { status: 200, body: { status: 'held', leaseUntil, ready } };
}

beforeEach(async () => {
  mockAcquire.mockReset();
  mockRelease.mockReset();
  mockRelease.mockResolvedValue({ status: 200, body: { status: 'released' } });
  await db.delete(ai_gateway_config).where(eq(ai_gateway_config.id, 1));
  await db
    .delete(auto_routing_custom_routers)
    .where(
      inArray(auto_routing_custom_routers.owned_by_user_id, userIds.length > 0 ? userIds : ['none'])
    );
});

async function newUser(): Promise<string> {
  const user = await insertTestUser();
  userIds.push(user.id);
  return user.id;
}

describe('promoteAliasTargets', () => {
  afterAll(async () => {
    await db.delete(ai_gateway_config).where(eq(ai_gateway_config.id, 1));
    if (userIds.length > 0) {
      await db
        .delete(auto_routing_custom_routers)
        .where(inArray(auto_routing_custom_routers.owned_by_user_id, userIds));
      await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
    }
  });

  it('pins a pool that never read its route, before the move, for the target it measured', async () => {
    const owner = await newUser();
    const pool = await seedPool({ userId: owner, slug: 'never-opened', entries: [gateway(ALIAS)] });
    await storeTargets([{ alias: ALIAS, target: OLD }]);
    mockAcquire.mockResolvedValue(held([{ router: 'efficient', model: OLD }]));

    const result = await promoteAliasTargets({
      next: [{ alias: ALIAS, target: NEW }],
      previous: previousFrom([{ alias: ALIAS, target: OLD }]),
    });

    expect(result).toEqual({ written: true, observed: 1 });
    expect(await entriesOf(pool)).toMatchObject([
      { kind: 'gateway', model: ALIAS, servingPin: { model: OLD, source: 'observed' } },
    ]);
    expect(await readTargets()).toEqual([{ alias: ALIAS, target: NEW }]);
  });

  it('pins the measured predecessor and skips unmeasured or linked entries', async () => {
    const owner = await newUser();
    const unmeasured = await seedPool({
      userId: owner,
      slug: 'unmeasured',
      entries: [gateway(ALIAS)],
    });
    const linked = await seedPool({
      userId: owner,
      slug: 'linked',
      entries: [{ kind: 'gateway', model: ALIAS, measuredAs: 'vendor/platform-target' }],
    });
    const retired = await seedPool({
      userId: owner,
      slug: 'retired',
      entries: [gateway(OTHER_ALIAS)],
    });
    await storeTargets([
      { alias: ALIAS, target: OLD },
      { alias: OTHER_ALIAS, target: OTHER_OLD },
    ]);
    // Only the other alias has a ready predecessor.
    mockAcquire.mockResolvedValue(held([{ router: 'efficient', model: OTHER_OLD }]));

    const result = await promoteAliasTargets({
      next: [
        { alias: ALIAS, target: NEW },
        { alias: OTHER_ALIAS, target: OTHER_NEW },
      ],
      previous: previousFrom([
        { alias: ALIAS, target: OLD },
        { alias: OTHER_ALIAS, target: OTHER_OLD },
      ]),
    });

    expect(result.written).toBe(true);
    expect(await entriesOf(unmeasured)).toEqual([gateway(ALIAS)]);
    expect(await entriesOf(linked)).toEqual([
      { kind: 'gateway', model: ALIAS, measuredAs: 'vendor/platform-target' },
    ]);
    expect(await entriesOf(retired)).toMatchObject([
      { kind: 'gateway', model: OTHER_ALIAS, servingPin: { model: OTHER_OLD, source: 'observed' } },
    ]);
  });

  it('still pins a predecessor that retired at the move once it has a ready measurement', async () => {
    const owner = await newUser();
    const pool = await seedPool({
      userId: owner,
      slug: 'retired-at-move',
      entries: [gateway(ALIAS)],
    });
    await storeTargets([{ alias: ALIAS, target: OLD }]);
    mockAcquire.mockResolvedValue(held([{ router: 'efficient', model: OLD }]));

    // The fresh snapshot no longer lists OLD, yet it served immediately before the move.
    const result = await promoteAliasTargets({
      next: [{ alias: ALIAS, target: NEW }],
      previous: previousFrom([{ alias: ALIAS, target: OLD }]),
    });

    expect(result).toEqual({ written: true, observed: 1 });
    expect(await entriesOf(pool)).toMatchObject([
      { kind: 'gateway', model: ALIAS, servingPin: { model: OLD, source: 'observed' } },
    ]);
  });

  it('writes no observation for a move whose predecessor was never stored', async () => {
    const owner = await newUser();
    const pool = await seedPool({ userId: owner, slug: 'first-target', entries: [gateway(ALIAS)] });
    await storeTargets([]);
    mockAcquire.mockResolvedValue(held([{ router: 'efficient', model: OLD }]));

    const result = await promoteAliasTargets({
      next: [{ alias: ALIAS, target: NEW }],
      previous: previousFrom([]),
    });

    expect(result).toEqual({ written: true, observed: 0 });
    expect(await entriesOf(pool)).toEqual([gateway(ALIAS)]);
    expect(mockAcquire).not.toHaveBeenCalled();
    expect(await readTargets()).toEqual([{ alias: ALIAS, target: NEW }]);
  });

  it('never rewrites an existing confirmation or observation', async () => {
    const owner = await newUser();
    const confirmedPool = await seedPool({
      userId: owner,
      slug: 'confirmed',
      entries: [{ kind: 'gateway', model: ALIAS, servingPin: confirmed(OLD) }],
    });
    const observedPool = await seedPool({
      userId: owner,
      slug: 'already-observed',
      entries: [{ kind: 'gateway', model: ALIAS, servingPin: observed(OLD) }],
    });
    await storeTargets([{ alias: ALIAS, target: OLD }]);
    mockAcquire.mockResolvedValue(held([{ router: 'efficient', model: OLD }]));

    const result = await promoteAliasTargets({
      next: [{ alias: ALIAS, target: NEW }],
      previous: previousFrom([{ alias: ALIAS, target: OLD }]),
    });

    expect(result).toEqual({ written: true, observed: 0 });
    expect(await entriesOf(confirmedPool)).toEqual([
      { kind: 'gateway', model: ALIAS, servingPin: confirmed(OLD) },
    ]);
    expect(await entriesOf(observedPool)).toEqual([
      { kind: 'gateway', model: ALIAS, servingPin: observed(OLD) },
    ]);
  });

  it('does not pin a pool created after the move', async () => {
    const owner = await newUser();
    const late = await seedPool({ userId: owner, slug: 'late', entries: [gateway(ALIAS)] });
    await storeTargets([{ alias: ALIAS, target: NEW }]);
    mockAcquire.mockResolvedValue(held([{ router: 'efficient', model: OLD }]));

    const result = await promoteAliasTargets({
      next: [{ alias: ALIAS, target: NEW }],
      // The stored config already moved: the late pool is not a candidate for an old target.
      previous: previousFrom([{ alias: ALIAS, target: NEW }]),
    });

    expect(result).toEqual({ written: true, observed: 0 });
    expect(await entriesOf(late)).toEqual([gateway(ALIAS)]);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('keeps the previous targets and writes nothing when the fence is held elsewhere', async () => {
    const owner = await newUser();
    const pool = await seedPool({ userId: owner, slug: 'busy', entries: [gateway(ALIAS)] });
    await storeTargets([{ alias: ALIAS, target: OLD }]);
    mockAcquire.mockResolvedValue({ status: 200, body: { status: 'busy' } });

    const result = await promoteAliasTargets({
      next: [{ alias: ALIAS, target: NEW }],
      previous: previousFrom([{ alias: ALIAS, target: OLD }]),
    });

    expect(result).toEqual({ written: false, observed: 0 });
    expect(await entriesOf(pool)).toEqual([gateway(ALIAS)]);
    expect(await readTargets()).toEqual([{ alias: ALIAS, target: OLD }]);
    expect(mockRelease).not.toHaveBeenCalled();
  });

  it('keeps the previous targets when the lease is too close to expiry', async () => {
    const owner = await newUser();
    const pool = await seedPool({ userId: owner, slug: 'expiring', entries: [gateway(ALIAS)] });
    await storeTargets([{ alias: ALIAS, target: OLD }]);
    mockAcquire.mockResolvedValue(held([{ router: 'efficient', model: OLD }], Date.now() + 1_000));

    const result = await promoteAliasTargets({
      next: [{ alias: ALIAS, target: NEW }],
      previous: previousFrom([{ alias: ALIAS, target: OLD }]),
    });

    expect(result).toEqual({ written: false, observed: 0 });
    expect(await entriesOf(pool)).toEqual([gateway(ALIAS)]);
    expect(await readTargets()).toEqual([{ alias: ALIAS, target: OLD }]);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous targets when the stored config moved under the promotion', async () => {
    const owner = await newUser();
    const pool = await seedPool({ userId: owner, slug: 'raced', entries: [gateway(ALIAS)] });
    await storeTargets([{ alias: ALIAS, target: NEW }]);
    mockAcquire.mockResolvedValue(held([{ router: 'efficient', model: OLD }]));

    const result = await promoteAliasTargets({
      next: [{ alias: ALIAS, target: NEW }],
      previous: previousFrom([{ alias: ALIAS, target: OLD }]),
    });

    expect(result).toEqual({ written: false, observed: 0 });
    expect(await entriesOf(pool)).toEqual([gateway(ALIAS)]);
    expect(await readTargets()).toEqual([{ alias: ALIAS, target: NEW }]);
  });

  it('refuses when the stored config was reset under a promotion that expected targets', async () => {
    const owner = await newUser();
    const pool = await seedPool({ userId: owner, slug: 'reset', entries: [gateway(ALIAS)] });
    mockAcquire.mockResolvedValue(held([{ router: 'efficient', model: OLD }]));

    const result = await promoteAliasTargets({
      next: [{ alias: ALIAS, target: NEW }],
      previous: previousFrom([{ alias: ALIAS, target: OLD }]),
    });

    expect(result).toEqual({ written: false, observed: 0 });
    expect(await entriesOf(pool)).toEqual([gateway(ALIAS)]);
    expect(await readTargets()).toEqual([]);
  });

  it('keeps a pool’s updated_at unchanged when pinning', async () => {
    const owner = await newUser();
    const pool = await seedPool({ userId: owner, slug: 'stamp', entries: [gateway(ALIAS)] });
    await storeTargets([{ alias: ALIAS, target: OLD }]);
    const before = await updatedAtOf(pool);
    mockAcquire.mockResolvedValue(held([{ router: 'efficient', model: OLD }]));

    await promoteAliasTargets({
      next: [{ alias: ALIAS, target: NEW }],
      previous: previousFrom([{ alias: ALIAS, target: OLD }]),
    });

    expect(await updatedAtOf(pool)).toBe(before);
  });

  it('scopes the readiness read to the pool’s base router', async () => {
    const owner = await newUser();
    const efficientPool = await seedPool({
      userId: owner,
      slug: 'efficient',
      baseRouter: 'efficient',
      entries: [gateway(ALIAS)],
    });
    const frontierPool = await seedPool({
      userId: owner,
      slug: 'frontier',
      baseRouter: 'frontier',
      entries: [gateway(ALIAS)],
    });
    await storeTargets([{ alias: ALIAS, target: OLD }]);
    mockAcquire.mockResolvedValue(held([{ router: 'efficient', model: OLD }]));

    const result = await promoteAliasTargets({
      next: [{ alias: ALIAS, target: NEW }],
      previous: previousFrom([{ alias: ALIAS, target: OLD }]),
    });

    expect(result).toEqual({ written: true, observed: 1 });
    expect(await entriesOf(efficientPool)).toMatchObject([
      { kind: 'gateway', model: ALIAS, servingPin: { model: OLD, source: 'observed' } },
    ]);
    expect(await entriesOf(frontierPool)).toEqual([gateway(ALIAS)]);
  });

  it('waits for an open pool write before its snapshot and commits both', async () => {
    const owner = await newUser();
    const pool = await seedPool({ userId: owner, slug: 'overlap', entries: [gateway(ALIAS)] });
    await storeTargets([{ alias: ALIAS, target: OLD }]);
    mockAcquire.mockResolvedValue(held([{ router: 'efficient', model: OLD }]));

    const writeApplied = Promise.withResolvers<void>();
    const writeMayCommit = Promise.withResolvers<void>();
    const write = db.transaction(async tx => {
      await lockAliasPromotionWrite(tx);
      await tx
        .update(auto_routing_custom_routers)
        .set({ name: 'edited while promoting' })
        .where(eq(auto_routing_custom_routers.id, pool));
      writeApplied.resolve();
      await writeMayCommit.promise;
    });

    try {
      await writeApplied.promise;
      let settled = false;
      const promotion = promoteAliasTargets({
        next: [{ alias: ALIAS, target: NEW }],
        previous: previousFrom([{ alias: ALIAS, target: OLD }]),
      }).finally(() => {
        settled = true;
      });
      await new Promise<void>(resolve => {
        setImmediate(resolve);
      });
      expect(settled).toBe(false);

      writeMayCommit.resolve();
      await write;
      expect(await promotion).toEqual({ written: true, observed: 1 });
      expect(await entriesOf(pool)).toMatchObject([
        { kind: 'gateway', model: ALIAS, servingPin: { model: OLD, source: 'observed' } },
      ]);
    } finally {
      writeMayCommit.resolve();
      await write;
    }
  });
});
