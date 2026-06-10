// Stub the Linear config module before the router imports linear-service,
// which reads these values at module load time.
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
import type { User, Organization } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import { organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';

describe('linearRouter authorization', () => {
  let owner: User;
  let trialExpiredOrg: Organization;

  beforeAll(async () => {
    owner = await insertTestUser({
      google_user_email: 'linear-owner@example.com',
      google_user_name: 'Linear Owner',
    });

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
