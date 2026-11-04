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
  const result = await upsertDirectoryUser(externalId, {
    directoryId,
    email,
    firstName: 'Bob',
    lastName: 'Bobert',
    idpId: `idp_${suffix}`,
  });
  createdUserIds.push(result.id);
  return result.id;
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
});

describe('upsertDirectoryUser', () => {
  test('creates a user bound to the directory user', async () => {
    const userId = await seedUser();

    const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, userId));

    expect(row.external_id).toBe(externalId);
    expect(row.google_user_email).toBe(email);
    expect(row.google_user_name).toBe('Bob Bobert');
    // `createOrUpdateUser` owns this, so a directory user is billable like any
    // other account rather than carrying a placeholder.
    expect(row.stripe_customer_id).toBeTruthy();
  });

  test('is idempotent: a replayed event returns the same user', async () => {
    const first = await seedUser();
    const second = await upsertDirectoryUser(externalId, {
      directoryId,
      email,
      firstName: 'Bob',
      lastName: 'Bobert',
      idpId: `idp_${suffix}`,
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
      idpId: `idp_${suffix}`,
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
        idpId: `idp_${suffix}`,
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
        idpId: `idp_${suffix}`,
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
      idpId: `idp_${suffix}`,
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
      idpId: `idp_a_${suffix}`,
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
        idpId: `idp_b_${suffix}`,
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
      idpId: `idp_${suffix}`,
    }).catch((error: unknown) => (error instanceof Error ? error.message : String(error)));

    expect(refusal).not.toContain(foreignEmail);
    expect(refusal).toContain(`unrelated-${suffix}.test`);
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

  test('removal leaves the parent membership and writes a tombstone', async () => {
    const parentId = await seedOrganization();
    const childId = await seedSubOrganization();
    const userId = await seedUser();
    await addDirectoryMembership({ directoryGroupId, externalId });

    await removeDirectoryMembership({ directoryGroupId, externalId });

    const remaining = await db
      .select({ organizationId: organization_memberships.organization_id })
      .from(organization_memberships)
      .where(eq(organization_memberships.kilo_user_id, userId));

    // Leaving one group must not revoke access to the directory's organization.
    expect(remaining.map(row => row.organizationId)).toEqual([parentId]);

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
