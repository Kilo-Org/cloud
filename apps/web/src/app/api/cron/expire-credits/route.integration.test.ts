jest.mock('@kilocode/web-shared/lib/config.server', () => ({ CRON_SECRET: 'cron-secret' }));
jest.mock('@kilocode/worker-utils/scheduled-job-observability', () => ({
  createScheduledJobRun: jest.fn(() => ({ runId: 'run-id' })),
  buildScheduledJobSuccessEvent: jest.fn((_run, fields) => fields),
  buildScheduledJobFailureEvent: jest.fn((_run, error) => ({ error })),
  emitScheduledJobEvent: jest.fn(),
}));

import { credit_transactions, kilocode_users, organizations } from '@kilocode/db/schema';
import { db, cleanupDbForTest } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { eq } from 'drizzle-orm';
import { GET } from './route';

function request() {
  return new Request('http://localhost/api/cron/expire-credits', {
    headers: { authorization: 'Bearer cron-secret' },
  });
}

async function seedOwners() {
  const expiry = new Date(Date.now() - 60_000).toISOString();
  const user = await insertTestUser({
    total_microdollars_acquired: 10_000_000,
    microdollars_used: 2_000_000,
    next_credit_expiration_at: expiry,
  });
  const org = await createOrganization('expiry-cron-test', user.id);
  await db
    .update(organizations)
    .set({
      total_microdollars_acquired: 10_000_000,
      microdollars_used: 2_000_000,
      microdollars_balance: 8_000_000,
      next_credit_expiration_at: expiry,
    })
    .where(eq(organizations.id, org.id));
  await db.insert(credit_transactions).values([
    {
      kilo_user_id: user.id,
      amount_microdollars: 10_000_000,
      is_free: true,
      expiry_date: expiry,
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
    },
    {
      kilo_user_id: user.id,
      organization_id: org.id,
      amount_microdollars: 10_000_000,
      is_free: true,
      expiry_date: expiry,
      expiration_baseline_microdollars_used: 0,
      original_baseline_microdollars_used: 0,
    },
  ]);
  return { user, org };
}

async function expectExpiredOnce(userId: string, orgId: string) {
  const user = await db.query.kilocode_users.findFirst({ where: eq(kilocode_users.id, userId) });
  const org = await db.query.organizations.findFirst({ where: eq(organizations.id, orgId) });
  expect(user).toMatchObject({
    total_microdollars_acquired: 2_000_000,
    next_credit_expiration_at: null,
  });
  expect(org).toMatchObject({
    total_microdollars_acquired: 2_000_000,
    microdollars_balance: 0,
    next_credit_expiration_at: null,
  });
  const expired = await db
    .select()
    .from(credit_transactions)
    .where(eq(credit_transactions.credit_category, 'credits_expired'));
  expect(expired).toHaveLength(2);
  expect(expired.map(row => row.amount_microdollars)).toEqual([-8_000_000, -8_000_000]);
}

describe('due credit cron database reconciliation', () => {
  afterEach(cleanupDbForTest);

  it('expires existing promotional deadlines without activation and is replay-safe', async () => {
    const { user, org } = await seedOwners();
    expect((await GET(request())).status).toBe(200);
    expect(await (await GET(request())).json()).toMatchObject({
      usersProcessed: 0,
      organizationsProcessed: 0,
      hasMore: false,
    });
    await expectExpiredOnce(user.id, org.id);
  });

  it('does not double reclaim principal when scheduled invocations overlap', async () => {
    const { user, org } = await seedOwners();
    const responses = await Promise.all([GET(request()), GET(request())]);
    expect(responses.map(response => response.status)).toEqual([200, 200]);
    await expectExpiredOnce(user.id, org.id);
  });

  it('leaves future and nonexpiring owners untouched and repairs stale due hints', async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const user = await insertTestUser({ next_credit_expiration_at: future });
    const perpetual = await insertTestUser({ next_credit_expiration_at: null });
    const stale = await insertTestUser({ next_credit_expiration_at: '2020-01-01T00:00:00Z' });
    expect(await (await GET(request())).json()).toMatchObject({ usersProcessed: 1 });
    const users = await db.select().from(kilocode_users);
    expect(users.find(row => row.id === user.id)?.next_credit_expiration_at).not.toBeNull();
    expect(users.find(row => row.id === perpetual.id)?.next_credit_expiration_at).toBeNull();
    expect(users.find(row => row.id === stale.id)?.next_credit_expiration_at).toBeNull();
  });
});
