import { randomUUID } from 'node:crypto';
import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { computeExpiration } from '@kilocode/web-shared/lib/creditExpiration';
import { recomputeUserBalances } from '@/lib/user/recompute-balances';
import { recomputeOrganizationBalances } from '@/lib/recomputeOrganizationBalances';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  auto_routing_benchmark_holds,
  credit_transactions,
  kilocode_users,
  organizations,
} from '@kilocode/db/schema';
import {
  benchmarkReserveSchema,
  benchmarkSettleSchema,
  reserveBenchmarkCredits,
  settleBenchmarkCredits,
} from './auto-routing-benchmark-billing';

const userIds: string[] = [];
const orgIds: string[] = [];

afterEach(async () => {
  const ids = [...userIds, ...orgIds];
  if (ids.length > 0) {
    await db
      .delete(auto_routing_benchmark_holds)
      .where(inArray(auto_routing_benchmark_holds.owner_id, ids));
    await db
      .delete(credit_transactions)
      .where(
        or(
          inArray(credit_transactions.kilo_user_id, userIds),
          inArray(credit_transactions.organization_id, orgIds)
        )
      );
  }
  if (orgIds.length > 0) await db.delete(organizations).where(inArray(organizations.id, orgIds));
  if (userIds.length > 0)
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, userIds));
  userIds.length = 0;
  orgIds.length = 0;
});

async function createOwner(ownerType: 'user' | 'org') {
  let ownerId: string;
  if (ownerType === 'user') {
    const user = await insertTestUser({
      id: `oauth/benchmark-${randomUUID()}`,
      total_microdollars_acquired: 10_000_000,
      microdollars_used: 0,
    });
    userIds.push(user.id);
    ownerId = user.id;
  } else {
    const [org] = await db
      .insert(organizations)
      .values({
        name: 'Benchmark billing test',
        total_microdollars_acquired: 10_000_000,
        microdollars_balance: 10_000_000,
      })
      .returning();
    if (!org) throw new Error('Missing test organization');
    orgIds.push(org.id);
    ownerId = org.id;
  }
  await db.insert(credit_transactions).values({
    kilo_user_id: ownerType === 'user' ? ownerId : 'system:auto-routing-benchmark',
    organization_id: ownerType === 'org' ? ownerId : null,
    amount_microdollars: 10_000_000,
    is_free: false,
  });
  return { admissionId: randomUUID(), ownerType, ownerId };
}

async function expectOwnerLedger(
  owner: { ownerType: 'user' | 'org'; ownerId: string },
  balance: number,
  spent = 0
) {
  const [row] =
    owner.ownerType === 'user'
      ? await db.select().from(kilocode_users).where(eq(kilocode_users.id, owner.ownerId))
      : await db.select().from(organizations).where(eq(organizations.id, owner.ownerId));
  expect(row?.total_microdollars_acquired).toBe((balance + spent) * 1_000_000);
  expect(row?.microdollars_used).toBe(spent * 1_000_000);
  if (row && 'microdollars_balance' in row)
    expect(row.microdollars_balance).toBe(balance * 1_000_000);
  const ledger = await db
    .select()
    .from(credit_transactions)
    .where(
      owner.ownerType === 'org'
        ? eq(credit_transactions.organization_id, owner.ownerId)
        : and(
            eq(credit_transactions.kilo_user_id, owner.ownerId),
            isNull(credit_transactions.organization_id)
          )
    );
  expect(ledger.reduce((sum, entry) => sum + entry.amount_microdollars, 0)).toBe(
    (balance + spent) * 1_000_000
  );
  return ledger;
}

const basePair = { model: 'test/model', variant: null };

describe.each(['user', 'org'] as const)('benchmark credits for %s owners', ownerType => {
  it('holds every lane atomically, charges successful cost, and releases failed remainder', async () => {
    const owner = await createOwner(ownerType);
    const input = {
      ...owner,
      items: [
        { ...basePair, estimatedCostUsd: 3 },
        { ...basePair, variant: 'high', estimatedCostUsd: 2 },
      ],
    };
    expect(await reserveBenchmarkCredits(input)).toMatchObject({ heldCostUsd: 5 });
    await expectOwnerLedger(owner, 5);
    expect(
      await settleBenchmarkCredits({ ...owner, ...basePair, runId: 'run-ready', actualCostUsd: 2 })
    ).toMatchObject({
      chargedCostUsd: 2,
      releasedCostUsd: 1,
    });
    expect(await reserveBenchmarkCredits(input)).toMatchObject({ heldCostUsd: 2 });
    expect(
      await settleBenchmarkCredits({
        ...owner,
        ...basePair,
        variant: 'high',
        runId: 'run-failed',
        actualCostUsd: 0,
      })
    ).toMatchObject({
      chargedCostUsd: 0,
      releasedCostUsd: 2,
    });
    await expectOwnerLedger(owner, 8, 2);
    expect(await reserveBenchmarkCredits(input)).toMatchObject({
      heldCostUsd: 0,
      items: [
        { status: 'settled', chargedCostUsd: 2 },
        { status: 'settled', chargedCostUsd: 0 },
      ],
    });
    await expectOwnerLedger(owner, 8, 2);
  });

  it('rejects an insufficient multi-lane hold without any partial debit', async () => {
    const owner = await createOwner(ownerType);
    await expect(
      reserveBenchmarkCredits({
        ...owner,
        items: [
          { ...basePair, estimatedCostUsd: 6 },
          { ...basePair, variant: 'high', estimatedCostUsd: 5 },
        ],
      })
    ).rejects.toMatchObject({
      status: 402,
      code: 'insufficient_credits',
      details: { availableCostUsd: 10, requiredCostUsd: 11 },
    });
    expect(
      await db
        .select()
        .from(auto_routing_benchmark_holds)
        .where(eq(auto_routing_benchmark_holds.owner_id, owner.ownerId))
    ).toHaveLength(0);
    expect(await expectOwnerLedger(owner, 10)).toHaveLength(1);
  });

  it('serializes concurrent admissions against the same available owner balance', async () => {
    const owner = await createOwner(ownerType);
    const results = await Promise.allSettled([
      reserveBenchmarkCredits({ ...owner, items: [{ ...basePair, estimatedCostUsd: 7 }] }),
      reserveBenchmarkCredits({
        ...owner,
        admissionId: randomUUID(),
        items: [{ ...basePair, estimatedCostUsd: 7 }],
      }),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toEqual([
      expect.objectContaining({
        reason: expect.objectContaining({ code: 'insufficient_credits' }),
      }),
    ]);
    await expectOwnerLedger(owner, 3);
  });

  it('replays reserve and simultaneous settlement without double charging or refunding', async () => {
    const owner = await createOwner(ownerType);
    const reserve = { ...owner, items: [{ ...basePair, estimatedCostUsd: 4 }] };
    await Promise.all([reserveBenchmarkCredits(reserve), reserveBenchmarkCredits(reserve)]);
    const settlement = { ...owner, ...basePair, runId: 'run-ready', actualCostUsd: 1.5 };
    const replies = await Promise.all([
      settleBenchmarkCredits(settlement),
      settleBenchmarkCredits(settlement),
    ]);
    expect(replies[0]).toEqual(replies[1]);
    expect(await expectOwnerLedger(owner, 8.5, 1.5)).toHaveLength(3);
    await expect(settleBenchmarkCredits({ ...settlement, actualCostUsd: 2 })).rejects.toMatchObject(
      { code: 'idempotency_conflict' }
    );
    await expect(
      settleBenchmarkCredits({ ...settlement, runId: 'another-run' })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expectOwnerLedger(owner, 8.5, 1.5);
  });

  it('rejects changed admission estimates and pair sets instead of extending a reservation', async () => {
    const owner = await createOwner(ownerType);
    await reserveBenchmarkCredits({ ...owner, items: [{ ...basePair, estimatedCostUsd: 4 }] });
    await expect(
      reserveBenchmarkCredits({ ...owner, items: [{ ...basePair, estimatedCostUsd: 5 }] })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expect(
      reserveBenchmarkCredits({
        ...owner,
        items: [{ ...basePair, variant: 'high', estimatedCostUsd: 4 }],
      })
    ).rejects.toMatchObject({ code: 'idempotency_conflict' });
    await expectOwnerLedger(owner, 6);
  });

  it('releases an unclaimed lane before a run exists and keeps failure replay free', async () => {
    const owner = await createOwner(ownerType);
    await reserveBenchmarkCredits({ ...owner, items: [{ ...basePair, estimatedCostUsd: 4 }] });
    const settlement = { ...owner, ...basePair, runId: null, actualCostUsd: 0 };
    await settleBenchmarkCredits(settlement);
    await settleBenchmarkCredits(settlement);
    expect(await expectOwnerLedger(owner, 10)).toHaveLength(3);
  });

  it('charges the full actual cost even when it exceeds the estimate', async () => {
    const owner = await createOwner(ownerType);
    await reserveBenchmarkCredits({ ...owner, items: [{ ...basePair, estimatedCostUsd: 2 }] });
    expect(
      await settleBenchmarkCredits({ ...owner, ...basePair, runId: 'run-ready', actualCostUsd: 12 })
    ).toMatchObject({ chargedCostUsd: 12, releasedCostUsd: 0 });
    await expectOwnerLedger(owner, -2, 12);
  });

  it('isolates null effort from a literal null variant and handles free lanes', async () => {
    const owner = await createOwner(ownerType);
    await reserveBenchmarkCredits({
      ...owner,
      items: [
        { ...basePair, estimatedCostUsd: 1 },
        { ...basePair, variant: 'null', estimatedCostUsd: 0 },
      ],
    });
    await settleBenchmarkCredits({
      ...owner,
      ...basePair,
      variant: 'null',
      runId: 'free-run',
      actualCostUsd: 0,
    });
    await expectOwnerLedger(owner, 9);
    await expect(
      settleBenchmarkCredits({
        ...owner,
        ...basePair,
        variant: 'high',
        runId: 'missing',
        actualCostUsd: 0,
      })
    ).rejects.toMatchObject({ code: 'hold_not_found' });
  });

  it('prevents a different owner from settling an admission with the same pair identity', async () => {
    const owner = await createOwner(ownerType);
    const otherOwner = await createOwner(ownerType);
    await reserveBenchmarkCredits({ ...owner, items: [{ ...basePair, estimatedCostUsd: 2 }] });
    await expect(
      settleBenchmarkCredits({
        ...otherOwner,
        admissionId: owner.admissionId,
        ...basePair,
        runId: 'run',
        actualCostUsd: 1,
      })
    ).rejects.toMatchObject({ code: 'hold_not_found' });
    await expectOwnerLedger(owner, 8);
    await expectOwnerLedger(otherOwner, 10);
  });

  it('blocks new admission for disabled owners but still allows their existing holds to release', async () => {
    const owner = await createOwner(ownerType);
    await reserveBenchmarkCredits({ ...owner, items: [{ ...basePair, estimatedCostUsd: 2 }] });
    if (ownerType === 'user') {
      await db
        .update(kilocode_users)
        .set({ blocked_reason: 'test block' })
        .where(eq(kilocode_users.id, owner.ownerId));
    } else {
      await db
        .update(organizations)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(organizations.id, owner.ownerId));
    }
    await expect(
      reserveBenchmarkCredits({
        ...owner,
        admissionId: randomUUID(),
        items: [{ ...basePair, estimatedCostUsd: 2 }],
      })
    ).rejects.toMatchObject({ status: 403, code: 'owner_blocked' });
    await settleBenchmarkCredits({ ...owner, ...basePair, runId: null, actualCostUsd: 0 });
    await expectOwnerLedger(owner, 10);
  });

  it('recomputes actual spend without treating holds or failed releases as usage', async () => {
    const owner = await createOwner(ownerType);
    await reserveBenchmarkCredits({
      ...owner,
      items: [
        { ...basePair, estimatedCostUsd: 3 },
        { ...basePair, variant: 'high', estimatedCostUsd: 2 },
        { ...basePair, variant: 'low', estimatedCostUsd: 1 },
      ],
    });
    await settleBenchmarkCredits({ ...owner, ...basePair, runId: 'ready', actualCostUsd: 2 });
    await settleBenchmarkCredits({
      ...owner,
      ...basePair,
      variant: 'high',
      runId: 'failed',
      actualCostUsd: 0,
    });
    const result =
      ownerType === 'user'
        ? await recomputeUserBalances({ userId: owner.ownerId, dryRun: true })
        : await recomputeOrganizationBalances({ organizationId: owner.ownerId, dryRun: true });
    expect(result.success).toBe(true);
    if (!result.success) throw new Error(result.error);
    expect(result.accounting_error_mUsd).toBe(0);
    expect(
      'user_update' in result
        ? result.user_update.microdollars_used
        : result.org_update.microdollars_used
    ).toBe(2_000_000);
    await expectOwnerLedger(owner, 7, 2);
  });

  it('counts settled benchmark usage when expiring promotional credit, instead of charging twice', async () => {
    const owner = await createOwner(ownerType);
    await reserveBenchmarkCredits({ ...owner, items: [{ ...basePair, estimatedCostUsd: 3 }] });
    await settleBenchmarkCredits({ ...owner, ...basePair, runId: 'ready', actualCostUsd: 2 });
    const result =
      ownerType === 'user'
        ? await recomputeUserBalances({ userId: owner.ownerId, dryRun: true })
        : await recomputeOrganizationBalances({ organizationId: owner.ownerId, dryRun: true });
    if (!result.success) throw new Error(result.error);
    const usage =
      'user_update' in result
        ? result.user_update.microdollars_used
        : result.org_update.microdollars_used;
    const expiresAt = new Date(Date.now() + 60_000);
    const expiration = computeExpiration(
      [
        {
          id: randomUUID(),
          amount_microdollars: 10_000_000,
          expiration_baseline_microdollars_used: 0,
          expiry_date: expiresAt.toISOString(),
          description: 'Test promotional credits',
          is_free: true,
        },
      ],
      { id: owner.ownerId, microdollars_used: usage },
      new Date(expiresAt.getTime() + 1000),
      owner.ownerId
    );
    expect(expiration.newTransactions[0]?.amount_microdollars).toBe(-8_000_000);
    await expectOwnerLedger(owner, 8, 2);
  });

  it('preserves microdollar-normalized quotes on reserve replay', async () => {
    const owner = await createOwner(ownerType);
    const input = { ...owner, items: [{ ...basePair, estimatedCostUsd: 0.007025 }] };
    const first = await reserveBenchmarkCredits(input);
    expect(first.items[0]?.estimatedCostUsd).toBe(0.007025);
    const replay = await reserveBenchmarkCredits({
      ...owner,
      items: first.items.map(item => ({
        model: item.model,
        variant: item.variant,
        estimatedCostUsd: item.estimatedCostUsd,
      })),
    });
    expect(replay).toEqual(first);
  });
});

it('processes personal bonus thresholds only for actual settled spend, not holds or failed lanes', async () => {
  const owner = await createOwner('user');
  await db
    .update(kilocode_users)
    .set({ kilo_pass_threshold: 2_000_000 })
    .where(eq(kilocode_users.id, owner.ownerId));
  await reserveBenchmarkCredits({
    ...owner,
    items: [
      { ...basePair, estimatedCostUsd: 3 },
      { ...basePair, variant: 'high', estimatedCostUsd: 1 },
    ],
  });
  await settleBenchmarkCredits({
    ...owner,
    ...basePair,
    variant: 'high',
    runId: 'failed',
    actualCostUsd: 0,
  });
  const [beforeSpend] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, owner.ownerId));
  expect(beforeSpend?.kilo_pass_threshold).toBe(2_000_000);
  expect(beforeSpend?.microdollars_used).toBe(0);
  await settleBenchmarkCredits({ ...owner, ...basePair, runId: 'ready', actualCostUsd: 2 });
  const [afterSpend] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, owner.ownerId));
  expect(afterSpend?.kilo_pass_threshold).toBeNull();
  await expectOwnerLedger(owner, 8, 2);
});

describe('benchmark billing input boundaries', () => {
  const owner = { admissionId: 'admission', ownerType: 'user', ownerId: 'oauth/not-a-uuid' };
  it('accepts OAuth user IDs but requires valid organization IDs', () => {
    expect(
      benchmarkReserveSchema.safeParse({ ...owner, items: [{ ...basePair, estimatedCostUsd: 1 }] })
        .success
    ).toBe(true);
    expect(
      benchmarkReserveSchema.safeParse({
        ...owner,
        ownerType: 'org',
        items: [{ ...basePair, estimatedCostUsd: 1 }],
      }).success
    ).toBe(false);
  });
  it.each([-1, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    'rejects invalid monetary amounts %s',
    amount => {
      expect(
        benchmarkReserveSchema.safeParse({
          ...owner,
          items: [{ ...basePair, estimatedCostUsd: amount }],
        }).success
      ).toBe(false);
      expect(
        benchmarkSettleSchema.safeParse({
          ...owner,
          ...basePair,
          runId: 'run',
          actualCostUsd: amount,
        }).success
      ).toBe(false);
    }
  );
  it('rejects repeated exact pairs and charged lanes without run IDs', () => {
    const item = { ...basePair, estimatedCostUsd: 1 };
    expect(benchmarkReserveSchema.safeParse({ ...owner, items: [item, item] }).success).toBe(false);
    expect(
      benchmarkSettleSchema.safeParse({ ...owner, ...basePair, runId: null, actualCostUsd: 1 })
        .success
    ).toBe(false);
  });
});
