import { beforeAll, describe, test, expect } from '@jest/globals';
import { getProfileRedirectPath } from '@/lib/user/profile-redirect-path';
import { db } from '@/lib/drizzle';
import {
  organization_domain_claims,
  organization_seats_purchases,
  organizations,
} from '@kilocode/db/schema';
import type { Organization, User } from '@kilocode/db/schema';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { eq } from 'drizzle-orm';

describe('getProfileRedirectPath', () => {
  let hardExpiredUser: User;
  let hardExpiredOrganization: Organization;
  let pastDueUser: User;
  let pastDueOrganization: Organization;

  beforeAll(async () => {
    hardExpiredUser = await insertTestUser({
      google_user_name: 'Hard Expired Redirect User',
    });
    hardExpiredOrganization = await createTestOrganization(
      'Hard Expired Redirect Org',
      hardExpiredUser.id,
      100_000,
      undefined,
      true
    );
    await db
      .update(organizations)
      .set({
        free_trial_end_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .where(eq(organizations.id, hardExpiredOrganization.id));

    pastDueUser = await insertTestUser({
      google_user_name: 'Past Due Redirect User',
    });
    pastDueOrganization = await createTestOrganization(
      'Past Due Redirect Org',
      pastDueUser.id,
      100_000,
      undefined,
      true
    );
    await db
      .update(organizations)
      .set({
        free_trial_end_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .where(eq(organizations.id, pastDueOrganization.id));
    await db.insert(organization_seats_purchases).values({
      organization_id: pastDueOrganization.id,
      subscription_stripe_id: 'sub_profile_redirect_past_due',
      subscription_status: 'past_due',
      seat_count: 2,
      amount_usd: 42,
      starts_at: '2026-04-01T00:00:00.000Z',
      expires_at: '2027-04-01T00:00:00.000Z',
      billing_cycle: 'yearly',
    });
  });

  test('redirects hard-expired single-organization users to profile without entitlement', async () => {
    await expect(getProfileRedirectPath(hardExpiredUser)).resolves.toBe('/profile');
  });

  test('keeps past-due seat purchase organizations on their organization page', async () => {
    await expect(getProfileRedirectPath(pastDueUser)).resolves.toBe(
      `/organizations/${pastDueOrganization.id}`
    );
  });

  test('redirects to the sales demo org when the user also has an older non-demo org', async () => {
    const user = await insertTestUser({
      google_user_name: 'Sales Demo Redirect User',
    });
    const olderOrg = await createTestOrganization('Older Non-Demo Org', user.id, 100_000);
    await db
      .update(organizations)
      .set({ created_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(organizations.id, olderOrg.id));

    const demoOrg = await createTestOrganization('Sales Demo Redirect Org', user.id, 0, {
      is_sales_demo: true,
    });

    await expect(getProfileRedirectPath(user)).resolves.toBe(`/organizations/${demoOrg.id}`);
  });

  test('prefers a permitted verified-domain organization over unrelated memberships', async () => {
    const user = await insertTestUser({
      google_user_name: 'Verified Domain Redirect User',
      google_user_email: 'person@redirect-preferred.example.com',
    });
    await createTestOrganization('Unrelated Redirect Org', user.id, 100_000);
    const preferred = await createTestOrganization('Preferred Redirect Org', user.id, 100_000);
    await db.insert(organization_domain_claims).values({
      organization_id: preferred.id,
      domain: 'redirect-preferred.example.com',
      status: 'verified',
      workos_organization_id: `workos-org-${crypto.randomUUID()}`,
      workos_domain_id: `workos-domain-${crypto.randomUUID()}`,
      verified_at: new Date().toISOString(),
    });

    await expect(getProfileRedirectPath(user)).resolves.toBe(`/organizations/${preferred.id}`);
  });

  describe('users with personal account disabled', () => {
    test('redirects multi-organization users to one of their organizations', async () => {
      const invitedUser = await insertTestUser({
        google_user_name: 'Invited Multi Org User',
        personal_account_disabled: true,
      });
      const orgA = await createTestOrganization('Invited Org A', invitedUser.id, 100_000);
      const orgB = await createTestOrganization('Invited Org B', invitedUser.id, 100_000);

      await expect(getProfileRedirectPath(invitedUser)).resolves.toMatch(
        new RegExp(`^/organizations/(${orgA.id}|${orgB.id})$`)
      );
    });

    test('falls back to connected accounts when the user has no organizations', async () => {
      const orphanUser = await insertTestUser({
        google_user_name: 'Invited Orphan User',
        personal_account_disabled: true,
      });

      await expect(getProfileRedirectPath(orphanUser)).resolves.toBe('/connected-accounts');
    });
  });
});
