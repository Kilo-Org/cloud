import { NextRequest } from 'next/server';

import { db } from '@kilocode/web-shared/lib/drizzle';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { credit_transactions, organizations } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { GET } from './route';

jest.setTimeout(30_000);

const MONTHLY_AMOUNT_MICRODOLLARS = 50_000_000;
const OSS_GITHUB_URL = 'https://github.com/example/sponsored-project';

type ResetResultPayload = {
  organizationId: string;
  creditsGranted: number;
  skippedReason?: string;
  success: boolean;
};

function createRequest() {
  return new NextRequest('http://localhost:3000/api/cron/oss-monthly-reset', {
    method: 'GET',
    headers: { authorization: `Bearer ${CRON_SECRET}` },
  });
}

async function resultsFor(response: Response, organizationId: string) {
  const payload = await response.json();
  return {
    payload,
    results: (payload.summary.results as ResetResultPayload[]).filter(
      entry => entry.organizationId === organizationId
    ),
  };
}

/**
 * Poll `pg_locks` until `expected` other backends wait on a row lock in this
 * database. The wait is a Postgres lock, not a timer: the short sleep only
 * spaces out the polls, and observing the waits proves both handler calls were
 * inside their transactions at the same time.
 */
async function waitForRowLockWaiters(expected: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const { rows } = await db.execute<{ n: number }>(sql`
      SELECT count(DISTINCT locked.pid)::int AS n
        FROM pg_locks locked
        JOIN pg_stat_activity activity ON activity.pid = locked.pid
       WHERE NOT locked.granted
         AND locked.pid <> pg_backend_pid()
         AND activity.datname = current_database()
    `);
    if (Number(rows[0]?.n ?? 0) >= expected) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${expected} row lock waiters`);
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

describe('GET /api/cron/oss-monthly-reset', () => {
  it('rejects requests without cron authorization', async () => {
    const response = await GET(
      new NextRequest('http://localhost:3000/api/cron/oss-monthly-reset', { method: 'GET' })
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: 'Unauthorized' });
  });

  it('grants one top-up to an organization per reset window', async () => {
    const owner = await insertTestUser();
    const organization = await createTestOrganization('OSS Latched', owner.id, 0, {
      oss_sponsorship_tier: 2,
      oss_monthly_credit_amount_microdollars: MONTHLY_AMOUNT_MICRODOLLARS,
      oss_github_url: OSS_GITHUB_URL,
    });

    // Hold the organization row in a separate transaction so both handler calls
    // reach their transactions before either can commit.
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const holder = db.transaction(async tx => {
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, organization.id))
        .for('update');
      held.resolve();
      await release.promise;
    });

    try {
      await held.promise;

      const firstRun = GET(createRequest());
      const secondRun = GET(createRequest());

      await waitForRowLockWaiters(2);
      release.resolve();

      const [first, second] = await Promise.all([firstRun, secondRun, holder]);

      const firstOrgResults = await resultsFor(first, organization.id);
      const secondOrgResults = await resultsFor(second, organization.id);

      // Both runs discovered the organization before the window was recorded,
      // and exactly one of them owns it.
      expect(firstOrgResults.results).toHaveLength(1);
      expect(secondOrgResults.results).toHaveLength(1);
      const outcomes = [...firstOrgResults.results, ...secondOrgResults.results]
        .map(entry => entry.skippedReason ?? 'topped_up')
        .sort();
      expect(outcomes).toEqual(['not_due_anymore', 'topped_up']);

      const grants = await db
        .select()
        .from(credit_transactions)
        .where(eq(credit_transactions.organization_id, organization.id));
      expect(grants).toHaveLength(1);
      expect(grants[0]!.credit_category).toBe('oss-monthly-reset');
      expect(grants[0]!.amount_microdollars).toBe(MONTHLY_AMOUNT_MICRODOLLARS);
      expect(grants[0]!.kilo_user_id).toBe(owner.id);

      const [reloaded] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, organization.id))
        .limit(1);

      expect(reloaded!.total_microdollars_acquired).toBe(MONTHLY_AMOUNT_MICRODOLLARS);
      expect(reloaded!.total_microdollars_acquired - reloaded!.microdollars_used).toBe(
        MONTHLY_AMOUNT_MICRODOLLARS
      );

      const settings = reloaded!.settings ?? {};
      expect(settings.oss_sponsorship_tier).toBe(2);
      expect(settings.oss_monthly_credit_amount_microdollars).toBe(MONTHLY_AMOUNT_MICRODOLLARS);
      expect(settings.oss_github_url).toBe(OSS_GITHUB_URL);
      const lastResetAt = Date.parse(settings.oss_credits_last_reset_at ?? '');
      expect(Number.isNaN(lastResetAt)).toBe(false);
      expect(Date.now() - lastResetAt).toBeLessThan(60_000);
    } finally {
      release.resolve();
      await holder;
    }
  });

  it('records the reset window without granting when the balance already meets the allocation', async () => {
    const owner = await insertTestUser();
    const organization = await createTestOrganization(
      'OSS Allocated',
      owner.id,
      MONTHLY_AMOUNT_MICRODOLLARS,
      {
        oss_sponsorship_tier: 3,
        oss_monthly_credit_amount_microdollars: MONTHLY_AMOUNT_MICRODOLLARS,
        oss_github_url: OSS_GITHUB_URL,
      }
    );

    const { results } = await resultsFor(await GET(createRequest()), organization.id);

    expect(results).toHaveLength(1);
    expect(results[0]!.skippedReason).toBe('balance_already_sufficient');
    expect(results[0]!.creditsGranted).toBe(0);

    const grants = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.organization_id, organization.id));
    expect(grants).toHaveLength(0);

    const [reloaded] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organization.id))
      .limit(1);
    expect(reloaded!.settings.oss_github_url).toBe(OSS_GITHUB_URL);
    expect(reloaded!.settings.oss_credits_last_reset_at).toBeTruthy();
    expect(reloaded!.total_microdollars_acquired).toBe(MONTHLY_AMOUNT_MICRODOLLARS);
  });

  it('leaves an organization alone while its reset window is current', async () => {
    const owner = await insertTestUser();
    const organization = await createTestOrganization('OSS Recent', owner.id, 0, {
      oss_sponsorship_tier: 1,
      oss_monthly_credit_amount_microdollars: MONTHLY_AMOUNT_MICRODOLLARS,
      oss_credits_last_reset_at: new Date(Date.now() - 60_000).toISOString(),
    });

    const { results } = await resultsFor(await GET(createRequest()), organization.id);

    expect(results).toHaveLength(0);

    const grants = await db
      .select()
      .from(credit_transactions)
      .where(eq(credit_transactions.organization_id, organization.id));
    expect(grants).toHaveLength(0);
  });
});
