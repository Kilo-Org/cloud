import { beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { organization_seats_purchases, organizations } from '@kilocode/db/schema';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { isNonTrialEnterpriseOrganization } from './non-trial-enterprise';

async function createOrganization(values: Partial<typeof organizations.$inferInsert>) {
  const user = await insertTestUser({
    google_user_email: `non-trial-enterprise-${crypto.randomUUID()}@example.com`,
  });
  const organization = await createTestOrganization('Org', user.id, 0);
  await db
    .update(organizations)
    .set({ plan: 'enterprise', require_seats: true, ...values })
    .where(eq(organizations.id, organization.id));
  return organization.id;
}

async function insertSeatPurchase(
  organizationId: string,
  subscription_status: (typeof organization_seats_purchases.$inferInsert)['subscription_status']
) {
  await db.insert(organization_seats_purchases).values({
    organization_id: organizationId,
    subscription_stripe_id: `sub_${crypto.randomUUID()}`,
    seat_count: 1,
    amount_usd: 72,
    starts_at: '2026-10-01T00:00:00.000Z',
    expires_at: '2026-11-01T00:00:00.000Z',
    subscription_status,
  });
}

describe('isNonTrialEnterpriseOrganization', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
  });

  it('is false for an enterprise organization in its trial', async () => {
    const organizationId = await createOrganization({});

    expect(await isNonTrialEnterpriseOrganization(organizationId)).toBe(false);
  });

  it('is true for an enterprise organization with a paid seat purchase', async () => {
    const organizationId = await createOrganization({});
    await insertSeatPurchase(organizationId, 'active');

    expect(await isNonTrialEnterpriseOrganization(organizationId)).toBe(true);
  });

  it('is false for an enterprise organization whose seat purchase ended', async () => {
    const organizationId = await createOrganization({});
    await insertSeatPurchase(organizationId, 'ended');

    expect(await isNonTrialEnterpriseOrganization(organizationId)).toBe(false);
  });

  it('is true for an enterprise organization that does not require seats', async () => {
    const organizationId = await createOrganization({ require_seats: false });

    expect(await isNonTrialEnterpriseOrganization(organizationId)).toBe(true);
  });

  it('is false for a paid teams organization', async () => {
    const organizationId = await createOrganization({ plan: 'teams' });
    await insertSeatPurchase(organizationId, 'active');

    expect(await isNonTrialEnterpriseOrganization(organizationId)).toBe(false);
  });

  it('is false for a deleted organization', async () => {
    const organizationId = await createOrganization({
      require_seats: false,
      deleted_at: new Date().toISOString(),
    });

    expect(await isNonTrialEnterpriseOrganization(organizationId)).toBe(false);
  });
});
