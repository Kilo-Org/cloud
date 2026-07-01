import { afterEach, describe, expect, test } from '@jest/globals';
import { eq } from 'drizzle-orm';

import { organizations } from '@kilocode/db/schema';
import { db } from '@/lib/drizzle';
import {
  resolveEffectiveOrganizationSsoPolicy,
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
});
