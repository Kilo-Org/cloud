import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  kilocode_users,
  organization_audit_logs,
  organization_memberships,
  organizations,
  user_auth_provider,
  type User,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  addUserToOrganization,
  createOrganization,
} from '@kilocode/web-shared/lib/organizations/organizations';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { upsertDirectoryOrganization, upsertDirectoryUser } from '@/lib/scim/directory-sync';
import { createOrUpdateUser, findUserByEmail, getUserAuthProviders } from '@/lib/user';
import { hasSsoVerifiedPrimaryAddress } from './sso-verified-address';

// Stripe is unreachable in tests (`.env.test` sets an invalid key), and
// directory sync provisions a customer for each organization and new user.
jest.mock('@/lib/organizations/organization-billing', () => ({
  getOrCreateStripeCustomerIdForOrganization: jest.fn().mockResolvedValue('cus_test_sso_org'),
}));

jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({
  createStripeCustomer: jest.fn().mockResolvedValue({ id: 'cus_test_sso_user' }),
  deleteStripeCustomer: jest.fn().mockResolvedValue(undefined),
}));

let suffix: string;
let domain: string;
let email: string;

const createdOrganizationIds: string[] = [];
const createdUserIds: string[] = [];

beforeEach(() => {
  suffix = randomUUID();
  domain = `sso-${suffix}.test`;
  email = `person@${domain}`;
});

afterEach(async () => {
  if (createdOrganizationIds.length > 0) {
    await db
      .delete(organization_audit_logs)
      .where(inArray(organization_audit_logs.organization_id, createdOrganizationIds));
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, createdOrganizationIds));
    await db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds));
    createdOrganizationIds.length = 0;
  }
  if (createdUserIds.length > 0) {
    await db
      .delete(user_auth_provider)
      .where(inArray(user_auth_provider.kilo_user_id, createdUserIds));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
    createdUserIds.length = 0;
  }
});

async function seedOrganization(ssoDomain: string | null): Promise<string> {
  const organization = await createOrganization(`SSO Org ${randomUUID()}`, null, false);
  createdOrganizationIds.push(organization.id);
  await db
    .update(organizations)
    .set({ sso_domain: ssoDomain })
    .where(eq(organizations.id, organization.id));
  return organization.id;
}

async function seedAccount(): Promise<User> {
  const user = await insertTestUser({ google_user_email: email });
  createdUserIds.push(user.id);
  return user;
}

/** The settlement `processSSOInternal` runs once WorkOS and the authority check pass. */
async function signInThroughSso(): Promise<void> {
  const result = await createOrUpdateUser(
    {
      google_user_email: email,
      google_user_name: 'Person',
      google_user_image_url: '',
      hosted_domain: domain,
      provider: 'workos',
      provider_account_id: `prof_${suffix}`,
      display_name: null,
    },
    undefined,
    true
  );
  expect(result.success).toBe(true);
}

async function ssoVerified(userId: string): Promise<boolean> {
  const [user] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, userId));
  return hasSsoVerifiedPrimaryAddress(user, await getUserAuthProviders(userId));
}

describe('hasSsoVerifiedPrimaryAddress', () => {
  test('counts an SSO sign-in on a domain whose authority the account belongs to', async () => {
    const authorityId = await seedOrganization(domain);
    const user = await seedAccount();
    await addUserToOrganization(authorityId, user.id, 'member');

    await signInThroughSso();

    expect(await ssoVerified(user.id)).toBe(true);
  });

  test('does not count a directory-provisioned row until an SSO sign-in replaces it', async () => {
    const directoryId = `directory_${suffix}`;
    const directory = await upsertDirectoryOrganization(directoryId, {
      workOSOrganizationId: `org_${suffix}`,
      name: `SCIM Org ${suffix}`,
    });
    createdOrganizationIds.push(directory.id);
    // The SSO domain satisfies directory sync's domain gate without asking WorkOS.
    await db
      .update(organizations)
      .set({ sso_domain: domain })
      .where(eq(organizations.id, directory.id));

    const provisioned = await upsertDirectoryUser(`directory_user_${suffix}`, {
      directoryId,
      email,
      firstName: 'Person',
      lastName: '',
    });
    createdUserIds.push(provisioned.id);
    await addUserToOrganization(directory.id, provisioned.id, 'member');

    // The domain requires SSO through this organization and the account is a
    // member, so only the row's origin keeps it out.
    expect(await getUserAuthProviders(provisioned.id)).toEqual([
      expect.objectContaining({ provider: 'workos', email, hosted_domain: null }),
    ]);
    expect(await ssoVerified(provisioned.id)).toBe(false);

    await signInThroughSso();

    expect((await findUserByEmail(email))?.id).toBe(provisioned.id);
    expect(await ssoVerified(provisioned.id)).toBe(true);
  });

  test('does not count an SSO sign-in once the domain no longer requires SSO', async () => {
    const authorityId = await seedOrganization(domain);
    const user = await seedAccount();
    await addUserToOrganization(authorityId, user.id, 'member');
    await signInThroughSso();

    await db
      .update(organizations)
      .set({ sso_domain: null })
      .where(eq(organizations.id, authorityId));

    expect(await ssoVerified(user.id)).toBe(false);
  });

  test('does not count an SSO sign-in when the account is outside the authority organization', async () => {
    const authorityId = await seedOrganization(domain);
    const otherId = await seedOrganization(null);
    const user = await seedAccount();
    await addUserToOrganization(otherId, user.id, 'member');
    await signInThroughSso();

    expect(await ssoVerified(user.id)).toBe(false);

    await addUserToOrganization(authorityId, user.id, 'member');

    expect(await ssoVerified(user.id)).toBe(true);
  });
});
