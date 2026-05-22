// LINEAR_CLIENT_ID is required by getLinearOAuthUrl, which captures it at
// module load time via @/lib/config.server. Stub the config module here so
// the OAuth URL builder doesn't throw in test envs without LINEAR_* set.
import type * as ConfigServerModule from '@/lib/config.server';
jest.mock('@/lib/config.server', () => {
  const actual = jest.requireActual<typeof ConfigServerModule>('@/lib/config.server');
  return {
    ...actual,
    LINEAR_CLIENT_ID: 'linear-client-id-test',
    LINEAR_CLIENT_SECRET: 'linear-client-secret-test',
    LINEAR_WEBHOOK_SECRET: 'linear-webhook-secret-test',
  };
});

import { describe, test, expect, beforeAll } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import type { User, Organization } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { organization_seats_purchases, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { addUserToOrganization } from '@/lib/organizations/organizations';

describe('linearRouter authorization', () => {
  let owner: User;
  let billingManager: User;
  let member: User;
  let outsider: User;
  let org: Organization;
  let trialExpiredOrg: Organization;
  let trialExpiredPastDueOrg: Organization;

  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: 'linear-owner@example.com',
      google_user_name: 'Linear Owner',
    });
    billingManager = await insertTestUser({
      google_user_email: 'linear-bm@example.com',
      google_user_name: 'Linear BM',
    });
    member = await insertTestUser({
      google_user_email: 'linear-member@example.com',
      google_user_name: 'Linear Member',
    });
    outsider = await insertTestUser({
      google_user_email: 'linear-outsider@example.com',
      google_user_name: 'Linear Outsider',
    });

    org = await createTestOrganization('Linear Auth Org', owner.id, 100_000);
    await addUserToOrganization(org.id, billingManager.id, 'billing_manager');
    await addUserToOrganization(org.id, member.id, 'member');

    trialExpiredOrg = await createTestOrganization(
      'Linear Trial Expired Org',
      owner.id,
      100_000,
      undefined,
      true // require_seats: true
    );
    // Force the trial into the hard-expired window (>3 days past end).
    await db
      .update(organizations)
      .set({
        free_trial_end_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .where(eq(organizations.id, trialExpiredOrg.id));

    trialExpiredPastDueOrg = await createTestOrganization(
      'Linear Trial Expired Past Due Org',
      owner.id,
      100_000,
      undefined,
      true
    );
    await db
      .update(organizations)
      .set({
        free_trial_end_at: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
      })
      .where(eq(organizations.id, trialExpiredPastDueOrg.id));
    await db.insert(organization_seats_purchases).values({
      organization_id: trialExpiredPastDueOrg.id,
      subscription_stripe_id: 'sub_linear_past_due',
      subscription_status: 'past_due',
      seat_count: 2,
      amount_usd: 42,
      starts_at: '2026-04-01T00:00:00.000Z',
      expires_at: '2027-04-01T00:00:00.000Z',
      billing_cycle: 'yearly',
    });
  });

  describe('getOAuthUrl', () => {
    test('user-scoped install does not require any role check', async () => {
      const caller = await createCallerForUser(owner.id);
      const result = await caller.linear.getOAuthUrl();
      expect(result.url).toMatch(/^https:\/\/linear\.app\/oauth\/authorize/);
    });

    test('owner can start an org-scoped install', async () => {
      const caller = await createCallerForUser(owner.id);
      const result = await caller.linear.getOAuthUrl({ organizationId: org.id });
      expect(result.url).toMatch(/^https:\/\/linear\.app\/oauth\/authorize/);
    });

    test('billing_manager can start an org-scoped install', async () => {
      const caller = await createCallerForUser(billingManager.id);
      const result = await caller.linear.getOAuthUrl({ organizationId: org.id });
      expect(result.url).toMatch(/^https:\/\/linear\.app\/oauth\/authorize/);
    });

    test('plain member is rejected with UNAUTHORIZED', async () => {
      const caller = await createCallerForUser(member.id);
      await expect(caller.linear.getOAuthUrl({ organizationId: org.id })).rejects.toBeInstanceOf(
        TRPCError
      );
      await expect(caller.linear.getOAuthUrl({ organizationId: org.id })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });

    test('non-member outsider is rejected with UNAUTHORIZED', async () => {
      const caller = await createCallerForUser(outsider.id);
      await expect(caller.linear.getOAuthUrl({ organizationId: org.id })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      });
    });

    test('org without active subscription / trial is rejected with FORBIDDEN', async () => {
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.linear.getOAuthUrl({ organizationId: trialExpiredOrg.id })
      ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });

    test('hard-expired org with a past-due seat purchase can still mutate', async () => {
      const caller = await createCallerForUser(owner.id);
      const result = await caller.linear.getOAuthUrl({
        organizationId: trialExpiredPastDueOrg.id,
      });

      expect(result.url).toMatch(/^https:\/\/linear\.app\/oauth\/authorize/);
    });
  });

  describe('uninstallApp', () => {
    test('org without active subscription / trial can still uninstall', async () => {
      // The trial-expired org has no Linear installation, so uninstall should
      // surface NOT_FOUND from the service layer rather than FORBIDDEN from
      // the subscription middleware. This proves the subscription gate is
      // not in the way of uninstall.
      const caller = await createCallerForUser(owner.id);
      await expect(
        caller.linear.uninstallApp({ organizationId: trialExpiredOrg.id })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });
});
