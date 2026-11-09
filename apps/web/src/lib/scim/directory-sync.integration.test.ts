import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import {
  kilocode_users,
  organization_audit_logs,
  organization_membership_removals,
  organization_memberships,
  organizations,
  user_auth_provider,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

import { addUserToOrganization } from '@kilocode/web-shared/lib/organizations/organizations';

import { createChildOrganization } from '@/lib/organizations/organization-hierarchy';
import { createOrUpdateUser } from '@/lib/user';

// Stripe is not reachable in tests (`.env.test` sets a deliberately invalid
// key), so the two entry points that provision a customer are stubbed. Both are
// exercised for real in production; what matters here is the directory-sync
// logic around them. `jest.mock('@/lib/organizations/organization-billing')`
// mirrors `src/routers/organizations/organization-creation.test.ts:19`.
jest.mock('@/lib/organizations/organization-billing', () => ({
  getOrCreateStripeCustomerIdForOrganization: jest.fn().mockResolvedValue('cus_test_scim_org'),
}));

jest.mock('@kilocode/web-shared/lib/stripe-client', () => ({
  createStripeCustomer: jest.fn().mockResolvedValue({ id: 'cus_test_scim_user' }),
  deleteStripeCustomer: jest.fn().mockResolvedValue(undefined),
}));

const organizationBilling = jest.requireMock<{
  getOrCreateStripeCustomerIdForOrganization: jest.Mock;
}>('@/lib/organizations/organization-billing');

import {
  addDirectoryMembership,
  deleteDirectoryOrganization,
  deleteDirectorySubOrganization,
  DirectorySyncConflictError,
  removeDirectoryMembership,
  upsertDirectoryOrganization,
  upsertDirectorySubOrganization,
  upsertDirectoryUser,
} from './directory-sync';

// WorkOS identifiers, shaped like the real ones from a directory-sync payload.
let suffix: string;
let directoryId: string;
let directoryGroupId: string;
let directoryIdpId: string;
let workOSOrganizationId: string;
let externalId: string;
let email: string;

const createdOrganizationIds: string[] = [];
const createdUserIds: string[] = [];

function trackOrganization(id: string): string {
  createdOrganizationIds.push(id);
  return id;
}

beforeEach(() => {
  suffix = randomUUID();
  directoryId = `directory_${suffix}`;
  directoryGroupId = `directory_group_${suffix}`;
  directoryIdpId = `idp_group_${suffix}`;
  workOSOrganizationId = `org_${suffix}`;
  externalId = `directory_user_${suffix}`;
  email = `scim-${suffix}@example.test`;
});

afterEach(async () => {
  if (createdOrganizationIds.length > 0) {
    await db
      .delete(organization_audit_logs)
      .where(inArray(organization_audit_logs.organization_id, createdOrganizationIds));
    await db
      .delete(organization_membership_removals)
      .where(inArray(organization_membership_removals.organization_id, createdOrganizationIds));
    await db
      .delete(organization_memberships)
      .where(inArray(organization_memberships.organization_id, createdOrganizationIds));
    // Children first: the self-referential foreign key is ON DELETE RESTRICT.
    await db
      .delete(organizations)
      .where(inArray(organizations.parent_organization_id, createdOrganizationIds));
    await db.delete(organizations).where(inArray(organizations.id, createdOrganizationIds));
    createdOrganizationIds.length = 0;
  }
  if (createdUserIds.length > 0) {
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, createdUserIds));
    createdUserIds.length = 0;
  }
});

async function seedOrganization(): Promise<string> {
  const result = await upsertDirectoryOrganization(directoryId, {
    workOSOrganizationId,
    name: `SCIM Org ${suffix}`,
  });
  return trackOrganization(result.id);
}

async function seedSubOrganization(): Promise<string> {
  const result = await upsertDirectorySubOrganization(directoryGroupId, {
    directoryId,
    directoryIdpId,
    name: `kilo-users-${suffix}`,
  });
  return trackOrganization(result.id);
}

async function seedUser(): Promise<string> {
  // The fixture domain is captured, so the address binds: a directory may bind
  // only an address at its organization's captured domain (rule 13), and the
  // gate runs before both takeover and first-bind provisioning.
  await seedOrganizationWithDomain('example.test');
  const result = await upsertDirectoryUser(externalId, {
    directoryId,
    email,
    firstName: 'Bob',
    lastName: 'Bobert',
  });
  createdUserIds.push(result.id);
  return result.id;
}

async function seedOrganizationWithDomain(domain: string): Promise<string> {
  const organizationId = await seedOrganization();
  // Fills only an absent domain, the same rule the capture path applies
  // (`.specs/organization-sso.md`, rule 14). A suite that captured a domain
  // before seeding a user keeps it, so a later helper cannot silently move the
  // authority its assertions were written against.
  await db
    .update(organizations)
    .set({ sso_domain: domain })
    .where(and(eq(organizations.id, organizationId), isNull(organizations.sso_domain)));
  return organizationId;
}

describe('upsertDirectoryOrganization', () => {
  test('creates an organization bound to the directory and the WorkOS organization', async () => {
    const organizationId = await seedOrganization();

    const [row] = await db.select().from(organizations).where(eq(organizations.id, organizationId));

    expect(row.directory_id).toBe(directoryId);
    expect(row.external_org_id).toBe(workOSOrganizationId);
    expect(row.parent_organization_id).toBeNull();
  });

  test('is idempotent: a replayed event returns the same organization', async () => {
    const first = await seedOrganization();
    const second = await upsertDirectoryOrganization(directoryId, {
      workOSOrganizationId,
      name: `SCIM Org ${suffix}`,
    });

    expect(second.id).toBe(first);
    expect(second.created).toBe(false);
  });

  test('adopts an existing organization that already carries the WorkOS id', async () => {
    // A customer-created organization is adopted rather than duplicated.
    const adopted = await upsertDirectoryOrganization(`directory_other_${suffix}`, {
      workOSOrganizationId,
      name: `Pre-existing ${suffix}`,
    });
    trackOrganization(adopted.id);

    const bound = await upsertDirectoryOrganization(directoryId, {
      workOSOrganizationId,
      name: `Ignored ${suffix}`,
    });

    expect(bound.id).toBe(adopted.id);
    expect(bound.created).toBe(false);
  });

  test('captures the event domain as the SSO domain, and re-audits nothing on replay', async () => {
    const domain = `integrator-${suffix}.okta.com`;
    const upsert = async () =>
      upsertDirectoryOrganization(directoryId, {
        workOSOrganizationId,
        name: `SCIM Org ${suffix}`,
        capturedDomains: [domain],
      });

    const organizationId = trackOrganization((await upsert()).id);

    const [row] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
    expect(row.sso_domain).toBe(domain);

    // A human capture writes this action; directory sync writes it with a null
    // actor, which is how a system-initiated organization change is recorded.
    const audits = await db
      .select({ action: organization_audit_logs.action, actorId: organization_audit_logs.actor_id })
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organizationId));
    expect(audits).toEqual([{ action: 'organization.sso.set_domain', actorId: null }]);

    // The set is skipped when it would not change the row, so replaying the
    // event does not append a second audit row.
    await upsert();
    const auditsAfterReplay = await db
      .select({ id: organization_audit_logs.id })
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organizationId));
    expect(auditsAfterReplay).toHaveLength(1);
  });

  test('leaves the SSO domain alone when another organization already holds it', async () => {
    const domain = `contested-${suffix}.test`;
    const incumbent = trackOrganization(
      (
        await upsertDirectoryOrganization(`directory_incumbent_${suffix}`, {
          workOSOrganizationId: `org_incumbent_${suffix}`,
          name: `Incumbent ${suffix}`,
          capturedDomains: [domain],
        })
      ).id
    );

    // Two authorities claiming one domain fails closed for both
    // (Policy Resolution rule 6), so the second claim must not land.
    const challenger = trackOrganization(
      (
        await upsertDirectoryOrganization(directoryId, {
          workOSOrganizationId,
          name: `Challenger ${suffix}`,
          capturedDomains: [domain],
        })
      ).id
    );

    const [incumbentRow] = await db
      .select({ ssoDomain: organizations.sso_domain })
      .from(organizations)
      .where(eq(organizations.id, incumbent));
    const [challengerRow] = await db
      .select({ ssoDomain: organizations.sso_domain })
      .from(organizations)
      .where(eq(organizations.id, challenger));

    expect(incumbentRow.ssoDomain).toBe(domain);
    expect(challengerRow.ssoDomain).toBeNull();
  });

  test('an event without domains does not clear a captured domain', async () => {
    const domain = `kept-${suffix}.test`;
    const organizationId = trackOrganization(
      (
        await upsertDirectoryOrganization(directoryId, {
          workOSOrganizationId,
          name: `SCIM Org ${suffix}`,
          capturedDomains: [domain],
        })
      ).id
    );

    // `dsync.deleted` omits `domains`, and releasing an SSO domain is a
    // deliberate administrative action rather than a sync side effect.
    await upsertDirectoryOrganization(directoryId, {
      workOSOrganizationId,
      name: `SCIM Org ${suffix}`,
    });

    const [row] = await db
      .select({ ssoDomain: organizations.sso_domain })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    expect(row.ssoDomain).toBe(domain);
  });

  test('a reordered or extended domain list does not move a captured domain', async () => {
    const primary = `acme-${suffix}.test`;
    const secondary = `subsidiary-${suffix}.test`;

    const organizationId = trackOrganization(
      (
        await upsertDirectoryOrganization(directoryId, {
          workOSOrganizationId,
          name: `SCIM Org ${suffix}`,
          capturedDomains: [primary],
        })
      ).id
    );

    // `data.domains[]` promises no order, and `sso_domain` decides who must
    // authenticate through SSO and which addresses a takeover may claim, so a
    // later activation listing the domains differently must not shift it.
    await upsertDirectoryOrganization(directoryId, {
      workOSOrganizationId,
      name: `SCIM Org ${suffix}`,
      capturedDomains: [secondary, primary],
    });

    const [row] = await db
      .select({ ssoDomain: organizations.sso_domain })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    expect(row.ssoDomain).toBe(primary);

    // And a domain the administrator set is never replaced either.
    await db
      .update(organizations)
      .set({ sso_domain: `admin-${suffix}.test` })
      .where(eq(organizations.id, organizationId));
    await upsertDirectoryOrganization(directoryId, {
      workOSOrganizationId,
      name: `SCIM Org ${suffix}`,
      capturedDomains: [secondary],
    });

    const [afterAdmin] = await db
      .select({ ssoDomain: organizations.sso_domain })
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    expect(afterAdmin.ssoDomain).toBe(`admin-${suffix}.test`);
  });
});

describe('upsertDirectorySubOrganization', () => {
  test('creates a sub-organization under the directory owner', async () => {
    const parentId = await seedOrganization();
    const childId = await seedSubOrganization();

    const [child] = await db.select().from(organizations).where(eq(organizations.id, childId));

    expect(child.parent_organization_id).toBe(parentId);
    expect(child.directory_group_id).toBe(directoryGroupId);
    expect(child.directory_idp_id).toBe(directoryIdpId);
  });

  test('is idempotent and applies a rename on repeat', async () => {
    await seedOrganization();
    const first = await seedSubOrganization();

    const renamed = await upsertDirectorySubOrganization(directoryGroupId, {
      directoryId,
      directoryIdpId,
      name: `kilo-admins-${suffix}`,
    });

    expect(renamed.id).toBe(first);
    expect(renamed.created).toBe(false);

    const [child] = await db.select().from(organizations).where(eq(organizations.id, first));
    expect(child.name).toBe(`kilo-admins-${suffix}`);
  });

  test('rejects a group whose directory has no organization', async () => {
    await expect(
      upsertDirectorySubOrganization(directoryGroupId, {
        directoryId: `directory_absent_${suffix}`,
        directoryIdpId,
        name: `orphan-${suffix}`,
      })
    ).rejects.toThrow(DirectorySyncConflictError);
  });

  test('refuses to nest a group under a sub-organization', async () => {
    // The hierarchy is one level deep.
    await seedOrganization();
    const childId = await seedSubOrganization();
    await db
      .update(organizations)
      .set({ directory_id: `directory_nested_${suffix}` })
      .where(eq(organizations.id, childId));

    await expect(
      upsertDirectorySubOrganization(`directory_group_nested_${suffix}`, {
        directoryId: `directory_nested_${suffix}`,
        directoryIdpId: `idp_nested_${suffix}`,
        name: `too-deep-${suffix}`,
      })
    ).rejects.toThrow(DirectorySyncConflictError);
  });

  test('resolves the directory owner even when a group row sorts ahead of it', async () => {
    const parentId = await seedOrganization();
    await seedSubOrganization();

    // A sub-organization inherits its parent's `directory_id`, so the directory
    // matches two live rows. Rewriting the parent's tuple moves it behind the
    // child in a sequential scan, which is enough to resolve the wrong row when
    // the lookup does not require an unparented one.
    await db
      .update(organizations)
      .set({ company_domain: `example-${suffix}.test` })
      .where(eq(organizations.id, parentId));

    const sibling = await upsertDirectorySubOrganization(`directory_group_b_${suffix}`, {
      directoryId,
      directoryIdpId: `idp_group_b_${suffix}`,
      name: `kilo-admins-${suffix}`,
    });
    trackOrganization(sibling.id);

    const [row] = await db.select().from(organizations).where(eq(organizations.id, sibling.id));
    expect(row.parent_organization_id).toBe(parentId);

    // The same ambiguity would make a replayed `dsync.activated` adopt a group.
    const replay = await upsertDirectoryOrganization(directoryId, {
      workOSOrganizationId,
      name: `SCIM Org ${suffix}`,
    });
    expect(replay).toEqual({ id: parentId, created: false });
  });

  test('a Stripe failure leaves no unbound child for a retry to duplicate', async () => {
    const parentId = await seedOrganization();

    // The real failure: `createChildOrganization` commits the row in its own
    // transaction and provisions the Stripe customer after it. Binding the
    // group in a later statement left a live child carrying no
    // `directory_group_id` whenever that provisioning failed — invisible to the
    // group lookup, so every retry added another.
    organizationBilling.getOrCreateStripeCustomerIdForOrganization.mockRejectedValueOnce(
      new Error('stripe is down')
    );

    await expect(
      upsertDirectorySubOrganization(directoryGroupId, {
        directoryId,
        directoryIdpId,
        name: `kilo-users-${suffix}`,
      })
    ).rejects.toThrow('stripe is down');

    const retried = await upsertDirectorySubOrganization(directoryGroupId, {
      directoryId,
      directoryIdpId,
      name: `kilo-users-${suffix}`,
    });
    trackOrganization(retried.id);

    // The row is either absent or fully bound, so the retry resolves exactly
    // one group under the parent.
    const children = await db
      .select({ id: organizations.id, groupId: organizations.directory_group_id })
      .from(organizations)
      .where(
        and(eq(organizations.parent_organization_id, parentId), isNull(organizations.deleted_at))
      );
    expect(children).toHaveLength(1);
    expect(children[0].groupId).toBe(directoryGroupId);
  });
});

describe('upsertDirectoryUser', () => {
  test('creates a user bound to the directory user', async () => {
    // A first bind is subject to the same captured-domain gate as a takeover
    // (rule 13), so the organization seeds with the fixture address's domain.
    await seedOrganizationWithDomain('example.test');

    const userId = await seedUser();

    const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, userId));

    expect(row.external_id).toBe(externalId);
    expect(row.google_user_email).toBe(email);
    expect(row.google_user_name).toBe('Bob Bobert');
    // `createOrUpdateUser` owns this, so a directory user is billable like any
    // other account rather than carrying a placeholder.
    expect(row.stripe_customer_id).toBeTruthy();
  });

  test('refuses to create a user at a domain the organization never captured', async () => {
    await seedOrganizationWithDomain(`captured-${suffix}.test`);

    // The account's own customer is minted by `createStripeCustomer` inside
    // `createOrUpdateUser`. Cleared here, after seeding, so the assertions below
    // see exactly the calls this refused upsert made — none.
    const stripeClient = jest.requireMock<{
      createStripeCustomer: jest.Mock;
      deleteStripeCustomer: jest.Mock;
    }>('@kilocode/web-shared/lib/stripe-client');
    stripeClient.createStripeCustomer.mockClear();
    stripeClient.deleteStripeCustomer.mockClear();

    const foreignEmail = `newcomer-${suffix}@unrelated-${suffix}.test`;

    await expect(
      upsertDirectoryUser(externalId, {
        directoryId,
        email: foreignEmail,
        firstName: 'New',
        lastName: 'Comer',
      })
    ).rejects.toThrow(DirectorySyncConflictError);

    // The refusal precedes provisioning, so no account was minted for the
    // address — and none carries the directory binding.
    const users = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.external_id, externalId));
    expect(users).toEqual([]);

    const byAddress = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.normalized_email, foreignEmail));
    expect(byAddress).toEqual([]);

    // No Stripe customer was settled for a user who was never created.
    expect(stripeClient.createStripeCustomer).not.toHaveBeenCalled();
    expect(stripeClient.deleteStripeCustomer).not.toHaveBeenCalled();

    // A retry of this same event fails identically: the directory is bound and
    // its captured domain is resolved, so the refusal is a policy answer rather
    // than the missing dependency a later event would satisfy. The reason names
    // the domain mismatch, not an absent organization.
    const retryError = await upsertDirectoryUser(externalId, {
      directoryId,
      email: foreignEmail,
      firstName: 'New',
      lastName: 'Comer',
    }).catch((error: unknown) => error);
    expect(retryError).toBeInstanceOf(DirectorySyncConflictError);
    expect(retryError instanceof Error ? retryError.message : '').toContain('captured domain');
  });

  test('is idempotent: a replayed event returns the same user', async () => {
    const first = await seedUser();
    const second = await upsertDirectoryUser(externalId, {
      directoryId,
      email,
      firstName: 'Bob',
      lastName: 'Bobert',
    });

    expect(second.id).toBe(first);
    expect(second.created).toBe(false);
  });

  test('takes over an existing account when the organization captured its domain', async () => {
    const organizationId = await seedOrganization();
    const domain = `captured-${suffix}.test`;
    await db
      .update(organizations)
      .set({ sso_domain: domain })
      .where(eq(organizations.id, organizationId));

    // A personal account on the captured domain, holding a non-SSO login and a
    // live browser session.
    const capturedEmail = `holder-${suffix}@${domain}`;
    const priorHolder = await createOrUpdateUser(
      {
        google_user_email: capturedEmail,
        google_user_name: 'Prior Holder',
        google_user_image_url: '',
        hosted_domain: null,
        provider: 'google',
        provider_account_id: `google_${suffix}`,
      },
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { skipSignupAdmission: true }
    );
    if (!priorHolder.success) throw new Error(`setup failed: ${priorHolder.error}`);
    createdUserIds.push(priorHolder.user.id);

    const taken = await upsertDirectoryUser(externalId, {
      directoryId,
      email: capturedEmail,
      firstName: 'Prior',
      lastName: 'Holder',
    });

    // The same account, not a second one: the address is unique per account.
    expect(taken.id).toBe(priorHolder.user.id);

    const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, taken.id));
    expect(row.external_id).toBe(externalId);
    // The prior holder keeps no live browser session (Authentication rule 7).
    expect(row.web_session_pepper).not.toBe(priorHolder.user.web_session_pepper);

    // ...and no non-SSO login survives, so they cannot sign back in past SSO.
    const providers = await db
      .select({ provider: user_auth_provider.provider })
      .from(user_auth_provider)
      .where(eq(user_auth_provider.kilo_user_id, taken.id));
    expect(providers.map(provider => provider.provider)).toEqual(['workos']);
  });

  test('refuses to take over an account whose domain the organization never captured', async () => {
    const organizationId = await seedOrganization();
    await db
      .update(organizations)
      .set({ sso_domain: `captured-${suffix}.test` })
      .where(eq(organizations.id, organizationId));

    const foreignEmail = `holder-${suffix}@unrelated-${suffix}.test`;
    const priorHolder = await createOrUpdateUser(
      {
        google_user_email: foreignEmail,
        google_user_name: 'Unrelated Person',
        google_user_image_url: '',
        hosted_domain: null,
        provider: 'google',
        provider_account_id: `google_${suffix}`,
      },
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { skipSignupAdmission: true }
    );
    if (!priorHolder.success) throw new Error(`setup failed: ${priorHolder.error}`);
    createdUserIds.push(priorHolder.user.id);

    await expect(
      upsertDirectoryUser(externalId, {
        directoryId,
        email: foreignEmail,
        firstName: 'Unrelated',
        lastName: 'Person',
      })
    ).rejects.toThrow(DirectorySyncConflictError);

    // The account is untouched: still its own login, still bound to nobody.
    const [row] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, priorHolder.user.id));
    expect(row.external_id).toBeNull();
    expect(row.web_session_pepper).toBe(priorHolder.user.web_session_pepper);

    const providers = await db
      .select({ provider: user_auth_provider.provider })
      .from(user_auth_provider)
      .where(eq(user_auth_provider.kilo_user_id, priorHolder.user.id));
    expect(providers.map(provider => provider.provider)).toEqual(['google']);
  });

  test('refuses a takeover when the organization has captured no domain at all', async () => {
    await seedOrganization();

    const unclaimedEmail = `holder-${suffix}@nopolicy-${suffix}.test`;
    const priorHolder = await createOrUpdateUser(
      {
        google_user_email: unclaimedEmail,
        google_user_name: 'No Policy',
        google_user_image_url: '',
        hosted_domain: null,
        provider: 'google',
        provider_account_id: `google_${suffix}`,
      },
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { skipSignupAdmission: true }
    );
    if (!priorHolder.success) throw new Error(`setup failed: ${priorHolder.error}`);
    createdUserIds.push(priorHolder.user.id);

    await expect(
      upsertDirectoryUser(externalId, {
        directoryId,
        email: unclaimedEmail,
        firstName: 'No',
        lastName: 'Policy',
      })
    ).rejects.toThrow(DirectorySyncConflictError);
  });

  test('takes over a case-variant address without creating a second account', async () => {
    const organizationId = await seedOrganization();
    const domain = `captured-${suffix}.test`;
    await db
      .update(organizations)
      .set({ sso_domain: domain })
      .where(eq(organizations.id, organizationId));

    // Stored with capitals; the directory delivers the same mailbox lowercased.
    const storedEmail = `Holder.${suffix}@${domain}`;
    const priorHolder = await createOrUpdateUser(
      {
        google_user_email: storedEmail,
        google_user_name: 'Prior Holder',
        google_user_image_url: '',
        hosted_domain: null,
        provider: 'google',
        provider_account_id: `google_${suffix}`,
      },
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { skipSignupAdmission: true }
    );
    if (!priorHolder.success) throw new Error(`setup failed: ${priorHolder.error}`);
    createdUserIds.push(priorHolder.user.id);

    const taken = await upsertDirectoryUser(externalId, {
      directoryId,
      email: storedEmail.toLowerCase(),
      firstName: 'Prior',
      lastName: 'Holder',
    });

    // The gate resolves the mailbox case-insensitively, so the conversion must
    // settle that same row rather than miss it on an exact-address match and
    // fall through to an insert.
    expect(taken.id).toBe(priorHolder.user.id);

    const forMailbox = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.normalized_email, storedEmail.toLowerCase()));
    expect(forMailbox).toHaveLength(1);

    const providers = await db
      .select({ provider: user_auth_provider.provider })
      .from(user_auth_provider)
      .where(eq(user_auth_provider.kilo_user_id, taken.id));
    expect(providers.map(provider => provider.provider)).toEqual(['workos']);
  });

  test('refuses to rebind an account that already belongs to another directory user', async () => {
    const organizationId = await seedOrganization();
    const domain = `captured-${suffix}.test`;
    await db
      .update(organizations)
      .set({ sso_domain: domain })
      .where(eq(organizations.id, organizationId));

    const sharedEmail = `shared-${suffix}@${domain}`;
    const first = await upsertDirectoryUser(`directory_user_A_${suffix}`, {
      directoryId,
      email: sharedEmail,
      firstName: 'Shared',
      lastName: 'Person',
    });
    createdUserIds.push(first.id);

    // A second directory user claiming the same mailbox must not silently take
    // the binding: events for the first identifier would then resolve to no
    // user, which the removal routes report as converged rather than failing.
    await expect(
      upsertDirectoryUser(`directory_user_B_${suffix}`, {
        directoryId,
        email: sharedEmail,
        firstName: 'Shared',
        lastName: 'Person',
      })
    ).rejects.toThrow(DirectorySyncConflictError);

    const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, first.id));
    expect(row.external_id).toBe(`directory_user_A_${suffix}`);
  });

  test('keeps the refused address out of the error it returns', async () => {
    const organizationId = await seedOrganization();
    await db
      .update(organizations)
      .set({ sso_domain: `captured-${suffix}.test` })
      .where(eq(organizations.id, organizationId));

    const foreignEmail = `holder-${suffix}@unrelated-${suffix}.test`;
    const priorHolder = await createOrUpdateUser(
      {
        google_user_email: foreignEmail,
        google_user_name: 'Unrelated Person',
        google_user_image_url: '',
        hosted_domain: null,
        provider: 'google',
        provider_account_id: `google_${suffix}`,
      },
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { skipSignupAdmission: true }
    );
    if (!priorHolder.success) throw new Error(`setup failed: ${priorHolder.error}`);
    createdUserIds.push(priorHolder.user.id);

    // The message is returned in the 409 body and logged again by
    // `directorySyncErrorResponse`, so it carries the domain, never the address.
    const refusal = await upsertDirectoryUser(externalId, {
      directoryId,
      email: foreignEmail,
      firstName: 'Unrelated',
      lastName: 'Person',
    }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

    expect(refusal).not.toContain(foreignEmail);
    expect(refusal).toContain(`unrelated-${suffix}.test`);
  });

  test('two directory users are never collapsed onto one account', async () => {
    const domainA = `a-${suffix}.test`;
    const domainB = `b-${suffix}.test`;
    const directoryB = `directory_other_${suffix}`;

    const organizationA = await seedOrganization();
    await db
      .update(organizations)
      .set({ sso_domain: domainA })
      .where(eq(organizations.id, organizationA));

    const organizationB = trackOrganization(
      (
        await upsertDirectoryOrganization(directoryB, {
          workOSOrganizationId: `org_other_${suffix}`,
          name: `Other ${suffix}`,
          capturedDomains: [domainB],
        })
      ).id
    );
    expect(organizationB).not.toBe(organizationA);

    const alice = await upsertDirectoryUser(`directory_user_A_${suffix}`, {
      directoryId,
      email: `alice-${suffix}@${domainA}`,
      firstName: 'Alice',
      lastName: 'A',
    });
    createdUserIds.push(alice.id);

    // A different person in a different directory. Keying the `workos` auth
    // provider row on the identity provider's own group-scoped id let a shared
    // value resolve this upsert to Alice's account — `createOrUpdateUser`
    // matches `(provider, provider_account_id)` before it looks at the address,
    // so neither the domain gate nor the rebind refusal ran.
    const bob = await upsertDirectoryUser(`directory_user_B_${suffix}`, {
      directoryId: directoryB,
      email: `bob-${suffix}@${domainB}`,
      firstName: 'Bob',
      lastName: 'B',
    });
    createdUserIds.push(bob.id);

    expect(bob.id).not.toBe(alice.id);

    const [aliceRow] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, alice.id));
    expect(aliceRow.external_id).toBe(`directory_user_A_${suffix}`);
    expect(aliceRow.google_user_email).toBe(`alice-${suffix}@${domainA}`);
  });

  test('applies a changed name and address to a bound directory user', async () => {
    const organizationId = await seedOrganization();
    // A subdomain, so the registrable-domain write is distinguishable from the
    // full host: `email_domain` holds eTLD+1 on the insert path.
    const domain = `mail.captured-${suffix}.test`;
    await db
      .update(organizations)
      .set({ sso_domain: domain })
      .where(eq(organizations.id, organizationId));

    const created = await upsertDirectoryUser(externalId, {
      directoryId,
      email: `old-${suffix}@${domain}`,
      firstName: 'Old',
      lastName: 'Name',
    });
    createdUserIds.push(created.id);
    const [before] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, created.id));

    // `dsync.user.updated` maps to this route. Ignoring the payload would leave
    // a stale address, which desynchronizes the address matching that SSO
    // sign-in and the takeover gate both rely on.
    const updated = await upsertDirectoryUser(externalId, {
      directoryId,
      email: `new-${suffix}@${domain}`,
      firstName: 'New',
      lastName: 'Name',
    });
    expect(updated.id).toBe(created.id);

    const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, created.id));
    expect(row.google_user_email).toBe(`new-${suffix}@${domain}`);
    expect(row.google_user_name).toBe('New Name');
    // `findUserByNormalizedEmail` and the signup dedup read this rather than
    // `google_user_email`.
    expect(row.normalized_email).toBe(`new-${suffix}@${domain}`);
    // The registrable domain, matching what the insert path stores — the full
    // host would skew the abuse grouping that reads this column.
    expect(row.email_domain).toBe(`captured-${suffix}.test`);
    // Sessions issued before the move belonged to the previous holder of that
    // mailbox, so they must not survive it.
    expect(row.web_session_pepper).not.toBe(before.web_session_pepper);

    // The provider row is a separate source for address lookups, so the old
    // address must not keep resolving to this account.
    const providers = await db
      .select({ email: user_auth_provider.email })
      .from(user_auth_provider)
      .where(eq(user_auth_provider.kilo_user_id, created.id));
    expect(providers.map(provider => provider.email)).toEqual([`new-${suffix}@${domain}`]);
  });

  test('a name-only change leaves sessions and the address alone', async () => {
    const organizationId = await seedOrganization();
    const domain = `captured-${suffix}.test`;
    await db
      .update(organizations)
      .set({ sso_domain: domain })
      .where(eq(organizations.id, organizationId));

    const created = await upsertDirectoryUser(externalId, {
      directoryId,
      email: `holder-${suffix}@${domain}`,
      firstName: 'Old',
      lastName: 'Name',
    });
    createdUserIds.push(created.id);
    const [before] = await db
      .select()
      .from(kilocode_users)
      .where(eq(kilocode_users.id, created.id));

    await upsertDirectoryUser(externalId, {
      directoryId,
      email: `holder-${suffix}@${domain}`,
      firstName: 'New',
      lastName: 'Name',
    });

    const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, created.id));
    expect(row.google_user_name).toBe('New Name');
    // No mailbox move, so no reason to sign anyone out.
    expect(row.web_session_pepper).toBe(before.web_session_pepper);
  });

  test('refuses to move a bound user onto a domain the organization never captured', async () => {
    const organizationId = await seedOrganization();
    const domain = `captured-${suffix}.test`;
    await db
      .update(organizations)
      .set({ sso_domain: domain })
      .where(eq(organizations.id, organizationId));

    const created = await upsertDirectoryUser(externalId, {
      directoryId,
      email: `holder-${suffix}@${domain}`,
      firstName: 'Holder',
      lastName: 'Person',
    });
    createdUserIds.push(created.id);

    // An address change is a takeover of a new mailbox, so it runs the same gate
    // as a first bind.
    await expect(
      upsertDirectoryUser(externalId, {
        directoryId,
        email: `holder-${suffix}@elsewhere-${suffix}.test`,
        firstName: 'Holder',
        lastName: 'Person',
      })
    ).rejects.toThrow(DirectorySyncConflictError);

    const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, created.id));
    expect(row.google_user_email).toBe(`holder-${suffix}@${domain}`);
  });
});

describe('directory membership', () => {
  test('adds the member to the sub-organization and its parent', async () => {
    const parentId = await seedOrganization();
    const childId = await seedSubOrganization();
    const userId = await seedUser();

    const result = await addDirectoryMembership({ directoryGroupId, externalId });

    expect(result.organizationId).toBe(childId);
    expect(result.parentOrganizationId).toBe(parentId);
    expect(result.created).toBe(true);

    const rows = await db
      .select({ organizationId: organization_memberships.organization_id })
      .from(organization_memberships)
      .where(eq(organization_memberships.kilo_user_id, userId));

    expect(rows.map(row => row.organizationId).toSorted()).toEqual([parentId, childId].toSorted());
  });

  test('is idempotent: a replayed add reports no change', async () => {
    await seedOrganization();
    await seedSubOrganization();
    await seedUser();

    await addDirectoryMembership({ directoryGroupId, externalId });
    const replay = await addDirectoryMembership({ directoryGroupId, externalId });

    expect(replay.created).toBe(false);
  });

  test('leaving one of several groups keeps the parent membership', async () => {
    const parentId = await seedOrganization();
    const childId = await seedSubOrganization();
    const userId = await seedUser();

    // A sibling group under the same parent, which the user stays in.
    const siblingGroupId = `directory_group_sibling_${suffix}`;
    const sibling = await upsertDirectorySubOrganization(siblingGroupId, {
      directoryId,
      directoryIdpId: `idp_group_sibling_${suffix}`,
      name: `on-call-${suffix}`,
    });
    trackOrganization(sibling.id);

    await addDirectoryMembership({ directoryGroupId, externalId });
    await addDirectoryMembership({ directoryGroupId: siblingGroupId, externalId });

    const result = await removeDirectoryMembership({ directoryGroupId, externalId });

    const remaining = await db
      .select({ organizationId: organization_memberships.organization_id })
      .from(organization_memberships)
      .where(eq(organization_memberships.kilo_user_id, userId));

    // The identity provider still places this person in the enterprise through
    // the sibling group, so the parent membership stays.
    expect(remaining.map(row => row.organizationId).toSorted()).toEqual(
      [parentId, sibling.id].toSorted()
    );
    expect(result.revokedParentMembership).toBe(false);

    const [tombstone] = await db
      .select()
      .from(organization_membership_removals)
      .where(
        and(
          eq(organization_membership_removals.organization_id, childId),
          eq(organization_membership_removals.kilo_user_id, userId)
        )
      );

    expect(tombstone.previous_role).toBe('member');
    // The actor is the identity provider, which has no Kilo user id.
    expect(tombstone.removed_by).toBeNull();
  });

  test('leaving the last group revokes the parent membership too', async () => {
    const parentId = await seedOrganization();
    await seedSubOrganization();
    const userId = await seedUser();
    await addDirectoryMembership({ directoryGroupId, externalId });

    const result = await removeDirectoryMembership({ directoryGroupId, externalId });

    // No group remains, so the identity provider no longer asserts that this
    // person belongs to the enterprise. Keeping the parent membership would let
    // a user deleted from the directory retain its seats and data.
    const remaining = await db
      .select({ organizationId: organization_memberships.organization_id })
      .from(organization_memberships)
      .where(eq(organization_memberships.kilo_user_id, userId));
    expect(remaining).toEqual([]);
    expect(result.revokedParentMembership).toBe(true);

    // Both removals leave a tombstone, so an ordinary SSO sign-in cannot
    // silently restore either membership.
    const tombstones = await db
      .select({ organizationId: organization_membership_removals.organization_id })
      .from(organization_membership_removals)
      .where(eq(organization_membership_removals.kilo_user_id, userId));
    expect(tombstones.map(row => row.organizationId)).toContain(parentId);

    // Idempotent: a replay finds nothing left to revoke.
    const replay = await removeDirectoryMembership({ directoryGroupId, externalId });
    expect(replay.revokedParentMembership).toBe(false);
  });

  test('a customer-created sibling does not keep the parent membership alive', async () => {
    const parentId = await seedOrganization();
    await seedSubOrganization();
    const userId = await seedUser();
    await addDirectoryMembership({ directoryGroupId, externalId });

    // A membership in a sub-organization with no directory binding is not the
    // identity provider's statement about enterprise membership.
    const manual = await createChildOrganization(`manual-${suffix}`, parentId);
    trackOrganization(manual.id);
    await addUserToOrganization(manual.id, userId, 'member');

    const result = await removeDirectoryMembership({ directoryGroupId, externalId });

    expect(result.revokedParentMembership).toBe(true);

    const remaining = await db
      .select({ organizationId: organization_memberships.organization_id })
      .from(organization_memberships)
      .where(eq(organization_memberships.kilo_user_id, userId));
    expect(remaining.map(row => row.organizationId)).toEqual([manual.id]);
  });

  test('a re-add clears the removal tombstone, because the directory is authoritative', async () => {
    const childId = await seedOrganization().then(async () => seedSubOrganization());
    const userId = await seedUser();
    await addDirectoryMembership({ directoryGroupId, externalId });
    await removeDirectoryMembership({ directoryGroupId, externalId });

    const readded = await addDirectoryMembership({ directoryGroupId, externalId });

    expect(readded.created).toBe(true);
    expect(readded.clearedRemovalTombstone).toBe(true);

    const tombstones = await db
      .select()
      .from(organization_membership_removals)
      .where(
        and(
          eq(organization_membership_removals.organization_id, childId),
          eq(organization_membership_removals.kilo_user_id, userId)
        )
      );

    expect(tombstones).toEqual([]);
  });

  test('rejects a membership for an unbound directory group', async () => {
    await seedUser();

    await expect(
      addDirectoryMembership({ directoryGroupId: `directory_group_absent_${suffix}`, externalId })
    ).rejects.toThrow(DirectorySyncConflictError);
  });

  test('rejects a membership for an unknown directory user', async () => {
    await seedOrganization();
    await seedSubOrganization();

    await expect(
      addDirectoryMembership({ directoryGroupId, externalId: `directory_user_absent_${suffix}` })
    ).rejects.toThrow(DirectorySyncConflictError);
  });

  test('a replayed removal reports no change', async () => {
    await seedOrganization();
    await seedSubOrganization();
    await seedUser();
    await addDirectoryMembership({ directoryGroupId, externalId });

    const first = await removeDirectoryMembership({ directoryGroupId, externalId });
    const replay = await removeDirectoryMembership({ directoryGroupId, externalId });

    expect(first.removed).toBe(true);
    expect(replay.removed).toBe(false);
  });

  test('removal converges for an unbound directory group', async () => {
    await seedUser();

    // Nothing to revoke is the state the event asks for, so this must not
    // conflict: provisioning the group would be creating rows for a departing
    // user, and a 409 would hold the Worker's cursor for an add that may never
    // arrive.
    const result = await removeDirectoryMembership({
      directoryGroupId: `directory_group_absent_${suffix}`,
      externalId,
    });

    expect(result).toEqual({
      organizationId: null,
      parentOrganizationId: null,
      kiloUserId: null,
      removed: false,
      revokedParentMembership: false,
    });
  });

  test('removal converges for an unknown directory user, and provisions nobody', async () => {
    const parentId = await seedOrganization();
    const childId = await seedSubOrganization();
    const absentExternalId = `directory_user_absent_${suffix}`;

    const result = await removeDirectoryMembership({
      directoryGroupId,
      externalId: absentExternalId,
    });

    expect(result).toEqual({
      organizationId: childId,
      parentOrganizationId: parentId,
      kiloUserId: null,
      removed: false,
      revokedParentMembership: false,
    });

    // A user leaving the directory must never be created by their own removal.
    const users = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(eq(kilocode_users.external_id, absentExternalId));
    expect(users).toEqual([]);
  });
});

describe('deleteDirectorySubOrganization', () => {
  test('soft-deletes the sub-organization and is idempotent', async () => {
    await seedOrganization();
    const childId = await seedSubOrganization();

    const first = await deleteDirectorySubOrganization(directoryGroupId);
    expect(first).toEqual({ id: childId, deleted: true });

    const [row] = await db.select().from(organizations).where(eq(organizations.id, childId));
    expect(row.deleted_at).not.toBeNull();

    // A replayed deletion finds no live row, which is the idempotent repeat.
    const replay = await deleteDirectorySubOrganization(directoryGroupId);
    expect(replay.deleted).toBe(false);
  });

  test('a soft-deleted group releases its binding for a new sub-organization', async () => {
    const parentId = await seedOrganization();
    const firstChildId = await seedSubOrganization();
    await deleteDirectorySubOrganization(directoryGroupId);

    // The unique index is partial on `deleted_at IS NULL`, so the same group id
    // can bind again after a disconnect and reconnect.
    const rebound = await upsertDirectorySubOrganization(directoryGroupId, {
      directoryId,
      directoryIdpId,
      name: `kilo-users-${suffix}`,
    });
    trackOrganization(rebound.id);

    expect(rebound.created).toBe(true);
    expect(rebound.id).not.toBe(firstChildId);

    const [row] = await db.select().from(organizations).where(eq(organizations.id, rebound.id));
    expect(row.parent_organization_id).toBe(parentId);
  });
});

describe('deleteDirectoryOrganization', () => {
  test('a directory disconnect soft-deletes the organization and its groups', async () => {
    const parentId = await seedOrganization();
    const childId = await seedSubOrganization();

    const result = await deleteDirectoryOrganization(directoryId);

    // A sub-organization carries its parent's `directory_id`, so the match must
    // resolve the unparented row rather than whichever row the index returns.
    expect(result).toEqual({ id: parentId, deleted: true });

    // Children go with the parent: a live group under a deleted organization
    // would keep matching group events for a directory that no longer exists.
    const live = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.directory_id, directoryId), isNull(organizations.deleted_at)));
    expect(live).toEqual([]);

    const [child] = await db.select().from(organizations).where(eq(organizations.id, childId));
    expect(child.deleted_at).not.toBeNull();

    const replay = await deleteDirectoryOrganization(directoryId);
    expect(replay.deleted).toBe(false);
  });

  test('leaves a customer-created sub-organization intact', async () => {
    const parentId = await seedOrganization();
    const groupId = await seedSubOrganization();
    const manual = await createChildOrganization(`manual-${suffix}`, parentId);
    trackOrganization(manual.id);

    await deleteDirectoryOrganization(directoryId);

    // `markOrganizationAsDeleted` hard-deletes an organization's
    // `cloud_agent_environments` and `provider_oauth_attempts`, so sweeping a
    // customer's own sub-organization into a directory disconnect would destroy
    // rows no reconnect could restore.
    const [manualRow] = await db
      .select({ deletedAt: organizations.deleted_at })
      .from(organizations)
      .where(eq(organizations.id, manual.id));
    expect(manualRow.deletedAt).toBeNull();

    const [groupRow] = await db
      .select({ deletedAt: organizations.deleted_at })
      .from(organizations)
      .where(eq(organizations.id, groupId));
    expect(groupRow.deletedAt).not.toBeNull();
  });

  test('soft-deletes the organization and its groups together', async () => {
    const parentId = await seedOrganization();
    const groupId = await seedSubOrganization();

    await deleteDirectoryOrganization(directoryId);

    // One transaction: committing the parent first would make a retry find no
    // live unparented row, report nothing deleted, and never reach the groups —
    // whose `directory_id` keeps matching group events.
    const rows = await db
      .select({ id: organizations.id, deletedAt: organizations.deleted_at })
      .from(organizations)
      .where(inArray(organizations.id, [parentId, groupId]));
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.deletedAt !== null)).toBe(true);
  });
});

describe('live-row scoping', () => {
  test('a soft-deleted organization does not satisfy a directory lookup', async () => {
    const organizationId = await seedOrganization();
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organizationId));

    // With the only bound row soft-deleted, a group event has no parent.
    await expect(
      upsertDirectorySubOrganization(directoryGroupId, {
        directoryId,
        directoryIdpId,
        name: `orphan-${suffix}`,
      })
    ).rejects.toThrow(DirectorySyncConflictError);

    const live = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(and(eq(organizations.directory_id, directoryId), isNull(organizations.deleted_at)));

    expect(live).toEqual([]);
  });
});
