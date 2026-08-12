import { afterEach, describe, expect, jest, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { organizations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import {
  resolveEffectiveOrganizationSsoPolicy,
  resolveEffectiveOrganizationSsoPolicies,
  resolveSsoAuthorityForDomain,
} from './organization-sso-policy';

describe('organization SSO policy', () => {
  const createdOrganizationIds: string[] = [];

  async function createOrganization(values: typeof organizations.$inferInsert) {
    const [organization] = await db.insert(organizations).values(values).returning();
    createdOrganizationIds.push(organization.id);
    return organization;
  }

  afterEach(async () => {
    for (const organizationId of createdOrganizationIds.toReversed()) {
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
    createdOrganizationIds.length = 0;
  });

  test('resolves a direct organization SSO policy', async () => {
    const organization = await createOrganization({
      name: 'Direct SSO Organization',
      sso_domain: 'Example.COM',
    });

    await expect(resolveEffectiveOrganizationSsoPolicy(organization.id)).resolves.toEqual({
      status: 'required',
      organizationId: organization.id,
      source: 'self',
      sourceOrganizationId: organization.id,
      domain: 'example.com',
    });
  });

  test('inherits SSO from a direct parent', async () => {
    const parent = await createOrganization({
      name: 'Parent Organization',
      sso_domain: 'example.com',
    });
    const child = await createOrganization({
      name: 'Child Organization',
      parent_organization_id: parent.id,
    });

    await expect(resolveEffectiveOrganizationSsoPolicy(child.id)).resolves.toEqual({
      status: 'required',
      organizationId: child.id,
      source: 'direct_parent',
      sourceOrganizationId: parent.id,
      domain: 'example.com',
    });
  });

  test('does not inherit through a nested parent', async () => {
    const root = await createOrganization({
      name: 'Root Organization',
      sso_domain: 'example.com',
    });
    const parent = await createOrganization({
      name: 'Parent Organization',
      parent_organization_id: root.id,
    });
    const child = await createOrganization({
      name: 'Child Organization',
      parent_organization_id: parent.id,
    });

    await expect(resolveEffectiveOrganizationSsoPolicy(child.id)).resolves.toEqual({
      status: 'misconfigured',
      organizationId: child.id,
      reason: 'unsupported_nested_parent',
    });
  });

  test('rejects a child with its own SSO domain', async () => {
    const parent = await createOrganization({
      name: 'Parent Organization',
      sso_domain: 'example.com',
    });
    const child = await createOrganization({
      name: 'Child Organization',
      parent_organization_id: parent.id,
      sso_domain: 'child.example.com',
    });

    await expect(resolveEffectiveOrganizationSsoPolicy(child.id)).resolves.toEqual({
      status: 'misconfigured',
      organizationId: child.id,
      reason: 'conflicting_child_policy',
    });
    await expect(resolveSsoAuthorityForDomain('child.example.com')).resolves.toEqual({
      status: 'misconfigured',
      domain: 'child.example.com',
      reason: 'conflicting_child_policy',
    });
  });

  test('fails closed when legacy organizations claim the same normalized domain', async () => {
    const first = await createOrganization({
      name: 'First Organization',
      sso_domain: 'example.com',
    });
    await createOrganization({
      name: 'Second Organization',
      sso_domain: 'EXAMPLE.COM',
    });

    await expect(resolveSsoAuthorityForDomain('example.com')).resolves.toEqual({
      status: 'misconfigured',
      domain: 'example.com',
      reason: 'ambiguous_domain',
    });
    await expect(resolveEffectiveOrganizationSsoPolicy(first.id)).resolves.toEqual({
      status: 'misconfigured',
      organizationId: first.id,
      reason: 'ambiguous_domain',
    });
  });

  test('fails closed when the direct parent was soft deleted', async () => {
    const parent = await createOrganization({
      name: 'Deleted Parent',
      sso_domain: 'example.com',
      deleted_at: new Date().toISOString(),
    });
    const child = await createOrganization({
      name: 'Child Organization',
      parent_organization_id: parent.id,
    });

    await expect(resolveEffectiveOrganizationSsoPolicy(child.id)).resolves.toEqual({
      status: 'misconfigured',
      organizationId: child.id,
      reason: 'deleted_parent',
    });
  });

  test('reports no SSO requirement for an unconfigured organization', async () => {
    const organization = await createOrganization({ name: 'Standard Organization' });

    await expect(resolveEffectiveOrganizationSsoPolicy(organization.id)).resolves.toEqual({
      status: 'not_required',
      organizationId: organization.id,
    });
  });

  test('batch resolution preserves scalar semantics for every policy outcome', async () => {
    const direct = await createOrganization({
      name: 'Batch Direct SSO Organization',
      sso_domain: 'Batch-Direct.EXAMPLE.com',
    });
    const parent = await createOrganization({
      name: 'Batch Parent Organization',
      sso_domain: 'batch-parent.example.com',
    });
    const child = await createOrganization({
      name: 'Batch Child Organization',
      parent_organization_id: parent.id,
    });
    const standard = await createOrganization({ name: 'Batch Standard Organization' });
    const standardParent = await createOrganization({ name: 'Batch Standard Parent' });
    const standardChild = await createOrganization({
      name: 'Batch Standard Child',
      parent_organization_id: standardParent.id,
    });
    const conflictingChild = await createOrganization({
      name: 'Batch Conflicting Child',
      parent_organization_id: parent.id,
      sso_domain: 'batch-conflicting.example.com',
    });
    const nestedRoot = await createOrganization({ name: 'Batch Nested Root' });
    const nestedParent = await createOrganization({
      name: 'Batch Nested Parent',
      parent_organization_id: nestedRoot.id,
    });
    const nestedChild = await createOrganization({
      name: 'Batch Nested Child',
      parent_organization_id: nestedParent.id,
    });
    const deletedParent = await createOrganization({
      name: 'Batch Deleted Parent',
      deleted_at: new Date().toISOString(),
    });
    const deletedParentChild = await createOrganization({
      name: 'Batch Deleted Parent Child',
      parent_organization_id: deletedParent.id,
    });
    const invalidDomain = await createOrganization({
      name: 'Batch Invalid Domain',
      sso_domain: 'not a domain',
    });
    const firstAmbiguous = await createOrganization({
      name: 'Batch First Ambiguous Organization',
      sso_domain: 'batch-ambiguous.example.com',
    });
    await createOrganization({
      name: 'Batch Second Ambiguous Organization',
      sso_domain: 'BATCH-AMBIGUOUS.EXAMPLE.COM',
    });
    const deletedOrganization = await createOrganization({
      name: 'Batch Deleted Organization',
      deleted_at: new Date().toISOString(),
    });
    const missingOrganizationId = '00000000-0000-4000-8000-000000000001';

    const expectedPolicies: EffectivePolicyExpectation[] = [
      {
        organizationId: direct.id,
        policy: {
          status: 'required',
          organizationId: direct.id,
          source: 'self',
          sourceOrganizationId: direct.id,
          domain: 'batch-direct.example.com',
        },
      },
      {
        organizationId: child.id,
        policy: {
          status: 'required',
          organizationId: child.id,
          source: 'direct_parent',
          sourceOrganizationId: parent.id,
          domain: 'batch-parent.example.com',
        },
      },
      {
        organizationId: standard.id,
        policy: { status: 'not_required', organizationId: standard.id },
      },
      {
        organizationId: standardChild.id,
        policy: { status: 'not_required', organizationId: standardChild.id },
      },
      {
        organizationId: conflictingChild.id,
        policy: {
          status: 'misconfigured',
          organizationId: conflictingChild.id,
          reason: 'conflicting_child_policy',
        },
      },
      {
        organizationId: nestedChild.id,
        policy: {
          status: 'misconfigured',
          organizationId: nestedChild.id,
          reason: 'unsupported_nested_parent',
        },
      },
      {
        organizationId: deletedParentChild.id,
        policy: {
          status: 'misconfigured',
          organizationId: deletedParentChild.id,
          reason: 'deleted_parent',
        },
      },
      {
        organizationId: invalidDomain.id,
        policy: {
          status: 'misconfigured',
          organizationId: invalidDomain.id,
          reason: 'invalid_domain',
        },
      },
      {
        organizationId: firstAmbiguous.id,
        policy: {
          status: 'misconfigured',
          organizationId: firstAmbiguous.id,
          reason: 'ambiguous_domain',
        },
      },
      {
        organizationId: deletedOrganization.id,
        policy: {
          status: 'misconfigured',
          organizationId: deletedOrganization.id,
          reason: 'organization_not_found',
        },
      },
      {
        organizationId: missingOrganizationId,
        policy: {
          status: 'misconfigured',
          organizationId: missingOrganizationId,
          reason: 'organization_not_found',
        },
      },
    ];
    const organizationIds = expectedPolicies.map(({ organizationId }) => organizationId);

    const policies = await resolveEffectiveOrganizationSsoPolicies(organizationIds);

    expect([...policies.entries()]).toEqual(
      expectedPolicies.map(({ organizationId, policy }) => [organizationId, policy])
    );
    for (const { organizationId, policy } of expectedPolicies) {
      await expect(resolveEffectiveOrganizationSsoPolicy(organizationId)).resolves.toEqual(policy);
    }
  });

  test('batch resolution uses a fixed select count', async () => {
    const direct = await createOrganization({
      name: 'Query Count Direct Organization',
      sso_domain: 'query-count-direct.example.com',
    });
    const parent = await createOrganization({
      name: 'Query Count Parent Organization',
      sso_domain: 'query-count-parent.example.com',
    });
    const child = await createOrganization({
      name: 'Query Count Child Organization',
      parent_organization_id: parent.id,
    });
    const standard = await createOrganization({ name: 'Query Count Standard Organization' });
    const selectSpy = jest.spyOn(db, 'select');

    await resolveEffectiveOrganizationSsoPolicies([direct.id]);
    expect(selectSpy).toHaveBeenCalledTimes(2);

    selectSpy.mockClear();
    await resolveEffectiveOrganizationSsoPolicies([direct.id, child.id, standard.id]);
    expect(selectSpy).toHaveBeenCalledTimes(2);

    selectSpy.mockRestore();
  });
});

type EffectivePolicyExpectation = {
  organizationId: string;
  policy: Awaited<ReturnType<typeof resolveEffectiveOrganizationSsoPolicy>>;
};
