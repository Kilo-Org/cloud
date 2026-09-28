import { db } from '@/lib/drizzle';
import { auto_top_up_configs, kilocode_users, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createOrganization } from '@/lib/organizations/organizations';
import { isAutoTopUpInFlight } from '@/lib/autoTopUpInFlight';
import { AUTO_TOP_UP_IN_FLIGHT_WINDOW_SECONDS } from '@/lib/autoTopUpConstants';

describe('isAutoTopUpInFlight', () => {
  let userId: string;
  let organizationId: string;

  beforeAll(async () => {
    const unique = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const user = await insertTestUser({
      google_user_email: `autotopup-inflight-${unique}@example.com`,
      google_user_name: 'Auto TopUp InFlight User',
      stripe_customer_id: `cus_inflight_${unique}`,
    });
    userId = user.id;

    const organization = await createOrganization(`Auto TopUp InFlight Org ${unique}`, user.id);
    organizationId = organization.id;
  });

  afterAll(async () => {
    await db.delete(auto_top_up_configs).where(eq(auto_top_up_configs.owned_by_user_id, userId));
    await db
      .delete(auto_top_up_configs)
      .where(eq(auto_top_up_configs.owned_by_organization_id, organizationId));
    await db.delete(organizations).where(eq(organizations.id, organizationId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
  });

  beforeEach(async () => {
    await db.delete(auto_top_up_configs).where(eq(auto_top_up_configs.owned_by_user_id, userId));
    await db
      .delete(auto_top_up_configs)
      .where(eq(auto_top_up_configs.owned_by_organization_id, organizationId));
  });

  it('returns false when no auto top-up config exists', async () => {
    await expect(isAutoTopUpInFlight({ userId })).resolves.toBe(false);
  });

  it('returns false when the config has no in-flight attempt', async () => {
    await db.insert(auto_top_up_configs).values({
      owned_by_user_id: userId,
      stripe_payment_method_id: 'pm_test_inflight',
      attempt_started_at: null,
    });

    await expect(isAutoTopUpInFlight({ userId })).resolves.toBe(false);
  });

  it('returns true while a recent attempt lock is held', async () => {
    await db.insert(auto_top_up_configs).values({
      owned_by_user_id: userId,
      stripe_payment_method_id: 'pm_test_inflight',
      attempt_started_at: new Date().toISOString(),
    });

    await expect(isAutoTopUpInFlight({ userId })).resolves.toBe(true);
  });

  it('returns false when the attempt lock is older than the in-flight window', async () => {
    const staleAt = new Date(
      Date.now() - (AUTO_TOP_UP_IN_FLIGHT_WINDOW_SECONDS + 60) * 1000
    ).toISOString();
    await db.insert(auto_top_up_configs).values({
      owned_by_user_id: userId,
      stripe_payment_method_id: 'pm_test_inflight',
      attempt_started_at: staleAt,
    });

    await expect(isAutoTopUpInFlight({ userId })).resolves.toBe(false);
  });

  it('returns true when the attempt lock is inside the in-flight window', async () => {
    const withinWindow = new Date(
      Date.now() - (AUTO_TOP_UP_IN_FLIGHT_WINDOW_SECONDS - 60) * 1000
    ).toISOString();
    await db.insert(auto_top_up_configs).values({
      owned_by_user_id: userId,
      stripe_payment_method_id: 'pm_test_inflight',
      attempt_started_at: withinWindow,
    });

    await expect(isAutoTopUpInFlight({ userId })).resolves.toBe(true);
  });

  it('returns true for an in-flight organization attempt', async () => {
    await db.insert(auto_top_up_configs).values({
      owned_by_organization_id: organizationId,
      stripe_payment_method_id: 'pm_test_inflight_org',
      attempt_started_at: new Date().toISOString(),
    });

    await expect(isAutoTopUpInFlight({ organizationId })).resolves.toBe(true);
    await expect(isAutoTopUpInFlight({ userId })).resolves.toBe(false);
  });

  it('returns false when neither owner id is provided', async () => {
    await expect(isAutoTopUpInFlight({})).resolves.toBe(false);
  });
});
