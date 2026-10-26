import { randomUUID } from 'node:crypto';
import { credit_transactions, kilocode_users, organizations } from '@kilocode/db/schema';
import { reconcileCreditExpirationsInTransaction } from '@kilocode/db/credit-expiration';
import { db, pool } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import {
  getBalanceAndOrgSettings,
  getBalanceForOrganizationUser,
  updateOrganizationUserLimit,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import { processLocalExpirations, processOrganizationExpirations } from './creditExpiration';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { after } from 'next/server';
import {
  maybePerformAutoTopUp,
  maybePerformOrganizationAutoTopUp,
} from '@kilocode/web-shared/lib/autoTopUp';

jest.mock('next/server', () => ({
  ...jest.requireActual('next/server'),
  after: jest.fn(),
}));
jest.mock('@kilocode/web-shared/lib/autoTopUp', () => ({
  maybePerformAutoTopUp: jest.fn().mockResolvedValue(undefined),
  maybePerformOrganizationAutoTopUp: jest.fn().mockResolvedValue(undefined),
}));

const dueAt = '2024-01-10T00:00:00.000Z';
const futureAt = '2099-02-10T00:00:00.000Z';
const now = new Date('2024-01-15T00:00:00.000Z');

async function waitForBlockedExpiration(blockerPid: number) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<{ blocked: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE $1::int = ANY(pg_blocking_pids(pid))
          AND wait_event_type = 'Lock'
          AND (query ILIKE '%for update%' OR query ILIKE '%for no key update%')
      ) AS blocked`,
      [blockerPid]
    );
    if (rows[0]?.blocked) return;
  }
  throw new Error('Expiration did not wait for the held owner row');
}

describe.each(['personal', 'organization'] as const)('%s locked credit expiration', scope => {
  const userIds: string[] = [];
  const organizationIds: string[] = [];
  const tableName = scope === 'personal' ? 'kilocode_users' : 'organizations';
  const currentUsageUpdate =
    scope === 'personal'
      ? 'microdollars_used = 900'
      : 'microdollars_used = 900, microdollars_balance = total_microdollars_acquired - 900';

  beforeEach(() => jest.clearAllMocks());

  afterEach(async () => {
    for (const organizationId of organizationIds.splice(0)) {
      await db
        .delete(credit_transactions)
        .where(eq(credit_transactions.organization_id, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
    for (const userId of userIds.splice(0)) {
      await db.delete(credit_transactions).where(eq(credit_transactions.kilo_user_id, userId));
      await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    }
  }, 30_000);

  async function fixture() {
    const user = await insertTestUser({
      microdollars_used: 300,
      total_microdollars_acquired: 2_000,
      next_credit_expiration_at: dueAt,
    });
    userIds.push(user.id);
    const org =
      scope === 'organization' ? await createOrganization('Expiration regression', user.id) : null;
    if (org) {
      organizationIds.push(org.id);
      await db
        .update(organizations)
        .set({
          microdollars_used: 300,
          total_microdollars_acquired: 2_000,
          microdollars_balance: 1_700,
          next_credit_expiration_at: dueAt,
          require_seats: false,
        })
        .where(eq(organizations.id, org.id));
    }
    const id = org?.id ?? user.id;
    const futureId = randomUUID();
    await db.insert(credit_transactions).values([
      {
        kilo_user_id: user.id,
        organization_id: org?.id ?? null,
        amount_microdollars: 1_000,
        is_free: true,
        expiry_date: dueAt,
        expiration_baseline_microdollars_used: 0,
        original_baseline_microdollars_used: 0,
      },
      {
        id: futureId,
        kilo_user_id: user.id,
        organization_id: org?.id ?? null,
        amount_microdollars: 1_000,
        is_free: true,
        expiry_date: futureAt,
        expiration_baseline_microdollars_used: 0,
        original_baseline_microdollars_used: 0,
      },
    ]);
    const ownerFilter = org
      ? eq(credit_transactions.organization_id, org.id)
      : and(
          eq(credit_transactions.kilo_user_id, user.id),
          isNull(credit_transactions.organization_id)
        );
    return {
      id,
      user,
      org,
      futureId,
      ownerFilter,
      expire: (options?: { force?: boolean }) =>
        scope === 'personal'
          ? processLocalExpirations(id, now, options)
          : processOrganizationExpirations(id, now, options),
      closures: () =>
        db
          .select()
          .from(credit_transactions)
          .where(and(ownerFilter, eq(credit_transactions.credit_category, 'credits_expired'))),
    };
  }

  test('uses fresh usage and moves future baselines without changing original baselines', async () => {
    const account = await fixture();
    await pool.query(`UPDATE ${tableName} SET ${currentUsageUpdate} WHERE id = $1`, [account.id]);

    const state = await account.expire();

    expect(state.microdollars_used).toBe(900);
    expect(state.total_microdollars_acquired).toBe(1_900);
    if (!state.next_credit_expiration_at) throw new Error('Expected a future expiration');
    expect(new Date(state.next_credit_expiration_at).toISOString()).toBe(futureAt);
    const closures = await account.closures();
    expect(closures).toHaveLength(1);
    expect(closures[0].amount_microdollars).toBe(-100);
    expect(closures[0].original_baseline_microdollars_used).toBe(900);
    const future = await db.query.credit_transactions.findFirst({
      where: eq(credit_transactions.id, account.futureId),
    });
    expect(future?.expiration_baseline_microdollars_used).toBe(900);
    expect(future?.original_baseline_microdollars_used).toBe(0);
    expect(await account.expire()).toEqual(state);
  });

  test('preserves acquired credits committed after the caller read its owner', async () => {
    const account = await fixture();
    await db.transaction(async tx => {
      await tx.insert(credit_transactions).values({
        kilo_user_id: account.user.id,
        organization_id: account.org?.id ?? null,
        amount_microdollars: 500,
        is_free: false,
        original_baseline_microdollars_used: 300,
      });
      await tx.execute(sql`
        UPDATE ${sql.identifier(tableName)}
        SET total_microdollars_acquired = total_microdollars_acquired + 500
        ${account.org ? sql`, microdollars_balance = microdollars_balance + 500` : sql``}
        WHERE id = ${account.id}
      `);
    });

    const state = await account.expire();
    expect(state.microdollars_used).toBe(300);
    expect(state.total_microdollars_acquired).toBe(1_800);
    expect(await account.closures()).toHaveLength(1);
    expect(await account.expire()).toEqual(state);
  });

  test('waits for a usage writer and makes progress using its committed usage', async () => {
    const account = await fixture();
    const writer = await pool.connect();
    let expiration: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT id FROM ${tableName} WHERE id = $1 FOR UPDATE`, [account.id]);
      const { rows } = await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const result = account.expire();
      expiration = result;
      await waitForBlockedExpiration(rows[0].pid);
      await writer.query(`UPDATE ${tableName} SET ${currentUsageUpdate} WHERE id = $1`, [
        account.id,
      ]);
      await writer.query('COMMIT');
      const state = await result;
      expect(state.microdollars_used).toBe(900);
      expect(state.total_microdollars_acquired).toBe(1_900);
      expect(await account.closures()).toHaveLength(1);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      await expiration;
    }
  });

  test('returns one coherent committed snapshot to concurrent callers and replays', async () => {
    const account = await fixture();
    const [first, second] = await Promise.all([account.expire(), account.expire()]);
    expect(first).toEqual(second);
    expect(first.microdollars_used).toBe(300);
    expect(first.total_microdollars_acquired).toBe(1_300);
    expect(await account.expire()).toEqual(first);
    expect(await account.closures()).toHaveLength(1);
  });

  test('rolls back owner changes, inserted closures, and baselines together', async () => {
    const account = await fixture();
    const failureName = `expiry_rollback_${randomUUID().replaceAll('-', '')}`;
    await db.execute(sql`
      CREATE FUNCTION ${sql.identifier(failureName)}() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'expiration regression rollback';
      END
      $$
    `);
    try {
      await db.execute(sql`
        CREATE TRIGGER ${sql.identifier(failureName)}
        BEFORE UPDATE OF expiration_baseline_microdollars_used ON ${credit_transactions}
        FOR EACH ROW WHEN (OLD.id = ${sql.raw(`'${account.futureId}'::uuid`)})
        EXECUTE FUNCTION ${sql.identifier(failureName)}()
      `);
      await expect(account.expire()).rejects.toThrow();
      const { rows } = await pool.query<{
        microdollars_used: string;
        total_microdollars_acquired: string;
        next_credit_expiration_at: Date;
        microdollars_balance?: string;
      }>(
        `SELECT microdollars_used, total_microdollars_acquired, next_credit_expiration_at${account.org ? ', microdollars_balance' : ''} FROM ${tableName} WHERE id = $1`,
        [account.id]
      );
      expect(Number(rows[0].microdollars_used)).toBe(300);
      expect(Number(rows[0].total_microdollars_acquired)).toBe(2_000);
      expect(new Date(rows[0].next_credit_expiration_at).toISOString()).toBe(dueAt);
      if (account.org) expect(Number(rows[0].microdollars_balance)).toBe(1_700);
      expect(await account.closures()).toHaveLength(0);
      const future = await db.query.credit_transactions.findFirst({
        where: eq(credit_transactions.id, account.futureId),
      });
      expect(future?.expiration_baseline_microdollars_used).toBe(0);
    } finally {
      await db.execute(
        sql`DROP TRIGGER IF EXISTS ${sql.identifier(failureName)} ON ${credit_transactions}`
      );
      await db.execute(sql`DROP FUNCTION ${sql.identifier(failureName)}()`);
    }
    const replay = await account.expire();
    expect(replay.total_microdollars_acquired).toBe(1_300);
    expect(await account.closures()).toHaveLength(1);
  });

  test('skips ledger work for a cleared hint unless an explicit forced refresh is requested', async () => {
    const account = await fixture();
    await pool.query(`UPDATE ${tableName} SET next_credit_expiration_at = NULL WHERE id = $1`, [
      account.id,
    ]);
    expect(await account.expire()).toEqual({
      microdollars_used: 300,
      total_microdollars_acquired: 2_000,
      next_credit_expiration_at: null,
    });
    expect(await account.closures()).toHaveLength(0);
    const forced = await account.expire({ force: true });
    expect(forced.total_microdollars_acquired).toBe(1_300);
    expect(await account.closures()).toHaveLength(1);
  });

  test('canonical reconciliation defaults to scanning due lots even with a cleared hint', async () => {
    const account = await fixture();
    await pool.query(`UPDATE ${tableName} SET next_credit_expiration_at = NULL WHERE id = $1`, [
      account.id,
    ]);
    expect((await account.expire()).total_microdollars_acquired).toBe(2_000);
    expect(await account.closures()).toHaveLength(0);

    const state = await db.transaction(tx =>
      reconcileCreditExpirationsInTransaction(
        { type: account.org ? 'organization' : 'user', id: account.id },
        tx,
        now
      )
    );
    expect(state.microdollars_used).toBe(300);
    expect(state.total_microdollars_acquired).toBe(1_300);
    expect(new Date(state.next_credit_expiration_at ?? '').toISOString()).toBe(futureAt);
    expect(await account.closures()).toHaveLength(1);
  });

  test('bounds inserts for histories larger than PostgreSQL parameter limits', async () => {
    const account = await fixture();
    await db.delete(credit_transactions).where(account.ownerFilter);
    await pool.query(
      `UPDATE ${tableName} SET microdollars_used = 0, total_microdollars_acquired = 8000${account.org ? ', microdollars_balance = 8000' : ''} WHERE id = $1`,
      [account.id]
    );
    await pool.query(
      `INSERT INTO credit_transactions (
        kilo_user_id, organization_id, amount_microdollars, is_free, expiry_date,
        expiration_baseline_microdollars_used, original_baseline_microdollars_used
      ) SELECT $1, $2, 1, true, $3::timestamptz, 0, 0 FROM generate_series(1, 8000)`,
      [account.user.id, account.org?.id ?? null, dueAt]
    );
    const state = await account.expire();
    expect(state).toEqual({
      microdollars_used: 0,
      total_microdollars_acquired: 0,
      next_credit_expiration_at: null,
    });
    const closures = await account.closures();
    expect(closures).toHaveLength(8_000);
    expect(closures.reduce((sum, closure) => sum + closure.amount_microdollars, 0)).toBe(-8_000);
    expect(await account.expire()).toEqual(state);
  });

  test('schedules funding only for usage and passes coherent fresh owner state', async () => {
    const account = await fixture();
    account.user.auto_top_up_enabled = true;
    await pool.query(
      `UPDATE ${tableName} SET auto_top_up_enabled = true, ${currentUsageUpdate} WHERE id = $1`,
      [account.id]
    );

    const ordinaryBalance = await getBalanceAndOrgSettings(account.org?.id, account.user);
    expect(ordinaryBalance.balance).toBe(0.001);
    expect(after).not.toHaveBeenCalled();

    const usageBalance = await getBalanceAndOrgSettings(
      account.org?.id,
      account.user,
      db,
      'usage'
    );
    expect(usageBalance).toEqual(ordinaryBalance);
    const callbacks = jest.mocked(after).mock.calls;
    expect(callbacks).toHaveLength(1);
    const callback = callbacks[0][0];
    if (typeof callback !== 'function') throw new Error('Expected scheduled funding callback');
    await callback();
    const topUp = account.org ? maybePerformOrganizationAutoTopUp : maybePerformAutoTopUp;
    expect(topUp).toHaveBeenCalledWith(
      expect.objectContaining({
        id: account.id,
        microdollars_used: 900,
        total_microdollars_acquired: 1_900,
      })
    );
  });

  test('uses current owner state for balance, payer, and allowance after a held-row race', async () => {
    const account = await fixture();
    if (account.org) await updateOrganizationUserLimit(account.org.id, account.user.id, 0.0025);
    const writer = await pool.connect();
    let balancePromise: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN');
      await writer.query(`SELECT id FROM ${tableName} WHERE id = $1 FOR UPDATE`, [account.id]);
      const { rows } = await writer.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const result = account.org
        ? getBalanceForOrganizationUser(account.org.id, account.user.id, {
            now,
            expiryJitterHours: 0,
          })
        : getBalanceAndOrgSettings(undefined, account.user);
      balancePromise = result;
      await waitForBlockedExpiration(rows[0].pid);
      await writer.query(`UPDATE ${tableName} SET ${currentUsageUpdate} WHERE id = $1`, [
        account.id,
      ]);
      await writer.query('COMMIT');
      const balance = await result;
      expect(balance.balance).toBe(0.001);
      expect(balance.payer).toEqual({
        createdAt: account.org?.created_at ?? account.user.created_at,
        microdollarsUsed: 900,
        totalMicrodollarsAcquired: 1_900,
      });
      expect(balance.balanceLimitedByUserAllowance).toBe(false);
    } finally {
      await writer.query('ROLLBACK');
      writer.release();
      await balancePromise;
    }
  });
});
