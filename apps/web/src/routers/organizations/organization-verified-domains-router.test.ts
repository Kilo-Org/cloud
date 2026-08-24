jest.mock('@workos-inc/node', () => {
  const actual = jest.requireActual('@workos-inc/node');
  const mockWorkOSInstance = {
    organizationDomains: {
      create: jest.fn(),
      delete: jest.fn(),
      get: jest.fn(),
      verify: jest.fn(),
    },
    organizations: {
      createOrganization: jest.fn(),
      deleteOrganization: jest.fn(),
      getOrganizationByExternalId: jest.fn(),
    },
    portal: { generateLink: jest.fn() },
    sso: { listConnections: jest.fn() },
  };
  return { ...actual, WorkOS: jest.fn(() => mockWorkOSInstance), mockWorkOSInstance };
});

import { db } from '@/lib/drizzle';
import { addUserToOrganization, createOrganization } from '@/lib/organizations/organizations';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@/tests/helpers/user.helper';
import {
  organization_audit_logs,
  organization_domain_claims,
  organization_memberships,
  organizations,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { OrganizationDomainState } from '@workos-inc/node';
import { and, eq, inArray } from 'drizzle-orm';

type WorkOSMock = {
  organizationDomains: {
    create: jest.Mock;
    delete: jest.Mock;
    get: jest.Mock;
    verify: jest.Mock;
  };
  organizations: {
    createOrganization: jest.Mock;
    deleteOrganization: jest.Mock;
    getOrganizationByExternalId: jest.Mock;
  };
  portal: { generateLink: jest.Mock };
  sso: { listConnections: jest.Mock };
};

const { mockWorkOSInstance } = jest.requireMock('@workos-inc/node') as {
  mockWorkOSInstance: WorkOSMock;
};

describe('organization verified domains router', () => {
  let owner: User;
  let organizationAdmin: User;
  let billingManager: User;
  let member: User;
  let kiloAdmin: User;
  let organization: Organization;
  let otherOrganization: Organization;

  const providerOrganization = (organizationId = organization.id, domains: object[] = []) => ({
    id: `workos-${organizationId}`,
    name: 'WorkOS Organization',
    externalId: organizationId,
    domains,
  });
  const providerDomain = (
    domain: string,
    state: OrganizationDomainState = OrganizationDomainState.Pending,
    organizationId = organization.id
  ) => ({
    object: 'organization_domain',
    id: `workos-domain-${domain}`,
    domain,
    organizationId: `workos-${organizationId}`,
    state,
    verificationStrategy: 'dns',
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
  });

  beforeAll(async () => {
    owner = await insertTestUser({ google_user_email: 'verified-domain-owner@example.com' });
    organizationAdmin = await insertTestUser({
      google_user_email: 'verified-domain-admin@example.com',
    });
    billingManager = await insertTestUser({
      google_user_email: 'verified-domain-billing@example.com',
    });
    member = await insertTestUser({ google_user_email: 'verified-domain-member@example.com' });
    kiloAdmin = await insertTestUser({
      google_user_email: 'verified-domain-kilo-admin@example.com',
      is_admin: true,
    });
    organization = await createOrganization('Verified Domain Organization', owner.id);
    otherOrganization = await createOrganization('Other Verified Domain Organization', owner.id);
    await addUserToOrganization(organization.id, organizationAdmin.id, 'admin');
    await addUserToOrganization(organization.id, billingManager.id, 'billing_manager');
    await addUserToOrganization(organization.id, member.id, 'member');
  });

  beforeEach(async () => {
    await db
      .delete(organization_domain_claims)
      .where(
        inArray(organization_domain_claims.organization_id, [organization.id, otherOrganization.id])
      );
    await db
      .delete(organization_audit_logs)
      .where(
        inArray(organization_audit_logs.organization_id, [organization.id, otherOrganization.id])
      );
    jest.clearAllMocks();
    mockWorkOSInstance.organizations.getOrganizationByExternalId.mockImplementation(
      async (organizationId: string) => providerOrganization(organizationId)
    );
    mockWorkOSInstance.organizationDomains.create.mockImplementation(
      async ({ domain, organizationId }: { domain: string; organizationId: string }) => ({
        ...providerDomain(domain),
        organizationId,
      })
    );
    mockWorkOSInstance.organizationDomains.get.mockImplementation(async (domainId: string) => {
      const domain = domainId.replace('workos-domain-', '');
      return providerDomain(domain);
    });
    mockWorkOSInstance.organizationDomains.verify.mockImplementation(async (domainId: string) => {
      const domain = domainId.replace('workos-domain-', '');
      return providerDomain(domain);
    });
    mockWorkOSInstance.organizationDomains.delete.mockResolvedValue(undefined);
    mockWorkOSInstance.portal.generateLink.mockResolvedValue({
      link: 'https://setup.workos.test/domain-verification',
    });
    mockWorkOSInstance.sso.listConnections.mockResolvedValue({ data: [] });
  });

  afterAll(async () => {
    await db
      .delete(organizations)
      .where(inArray(organizations.id, [organization.id, otherOrganization.id]));
  });

  test('allows owner and organization admin but rejects billing-only and member roles', async () => {
    const ownerCaller = await createCallerForUser(owner.id);
    const adminCaller = await createCallerForUser(organizationAdmin.id);
    await expect(
      ownerCaller.organizations.verifiedDomains.list({ organizationId: organization.id })
    ).resolves.toEqual([]);
    await expect(
      adminCaller.organizations.verifiedDomains.list({ organizationId: organization.id })
    ).resolves.toEqual([]);

    for (const user of [billingManager, member]) {
      const caller = await createCallerForUser(user.id);
      await expect(
        caller.organizations.verifiedDomains.list({ organizationId: organization.id })
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    }
  });

  test('rejects ineligible domains before any provider or database side effect', async () => {
    const caller = await createCallerForUser(owner.id);
    await expect(
      caller.organizations.verifiedDomains.create({
        organizationId: organization.id,
        domain: ' GMAIL.com ',
      })
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    expect(mockWorkOSInstance.organizationDomains.create).not.toHaveBeenCalled();
    expect(await db.query.organization_domain_claims.findMany()).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ organization_id: organization.id })])
    );
  });

  test('does not create or audit a claim for a deleted organization', async () => {
    await db
      .update(organizations)
      .set({ deleted_at: new Date().toISOString() })
      .where(eq(organizations.id, organization.id));
    const caller = await createCallerForUser(owner.id);

    try {
      await expect(
        caller.organizations.verifiedDomains.create({
          organizationId: organization.id,
          domain: 'deleted-organization.example.com',
        })
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(mockWorkOSInstance.organizations.getOrganizationByExternalId).not.toHaveBeenCalled();
      expect(
        await db.query.organization_domain_claims.findFirst({
          where: eq(organization_domain_claims.domain, 'deleted-organization.example.com'),
        })
      ).toBeUndefined();
      expect(await claimAuditActions()).toEqual([]);
    } finally {
      await db
        .update(organizations)
        .set({ deleted_at: null })
        .where(eq(organizations.id, organization.id));
    }
  });

  test('creates a canonical pending claim, stores exact provider IDs, returns a flow, and audits once', async () => {
    const caller = await createCallerForUser(owner.id);
    const result = await caller.organizations.verifiedDomains.create({
      organizationId: organization.id,
      domain: ' Example.COM ',
    });

    expect(result).toMatchObject({
      claim: { domain: 'example.com', status: 'pending', verifiedAt: null },
      verificationLink: 'https://setup.workos.test/domain-verification',
    });
    expect(mockWorkOSInstance.organizationDomains.create).toHaveBeenCalledWith({
      domain: 'example.com',
      organizationId: `workos-${organization.id}`,
    });
    const claim = await db.query.organization_domain_claims.findFirst({
      where: eq(organization_domain_claims.id, result.claim.id),
    });
    expect(claim).toMatchObject({
      workos_domain_id: 'workos-domain-example.com',
      workos_organization_id: `workos-${organization.id}`,
    });
    expect(await claimAuditActions()).toEqual(['organization.domain_claim.create']);
  });

  test('creates a WorkOS organization by local external ID when none exists', async () => {
    mockWorkOSInstance.organizations.getOrganizationByExternalId.mockRejectedValueOnce({
      status: 404,
    });
    mockWorkOSInstance.organizations.createOrganization.mockResolvedValueOnce(
      providerOrganization(organization.id)
    );
    const caller = await createCallerForUser(owner.id);

    await caller.organizations.verifiedDomains.create({
      organizationId: organization.id,
      domain: 'new-workos-org.example.com',
    });

    expect(mockWorkOSInstance.organizations.createOrganization).toHaveBeenCalledWith(
      { name: organization.name, externalId: organization.id },
      { idempotencyKey: `verified-domain-${organization.id}` }
    );
  });

  test('reuses an existing claim and provider domain on retry without duplicate audit effects', async () => {
    const caller = await createCallerForUser(owner.id);
    const first = await caller.organizations.verifiedDomains.create({
      organizationId: organization.id,
      domain: 'retry.example.com',
    });
    const second = await caller.organizations.verifiedDomains.create({
      organizationId: organization.id,
      domain: 'retry.example.com',
    });

    expect(second.claim.id).toBe(first.claim.id);
    expect(mockWorkOSInstance.organizationDomains.create).toHaveBeenCalledTimes(1);
    expect(mockWorkOSInstance.organizationDomains.get).toHaveBeenCalledWith(
      'workos-domain-retry.example.com'
    );
    expect(await claimAuditActions()).toEqual(['organization.domain_claim.create']);
  });

  test('retains a pending claim after provider setup fails and completes it on retry', async () => {
    mockWorkOSInstance.organizationDomains.create.mockRejectedValueOnce(new Error('unavailable'));
    const caller = await createCallerForUser(owner.id);
    const input = { organizationId: organization.id, domain: 'provider-retry.example.com' };

    await expect(caller.organizations.verifiedDomains.create(input)).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Domain verification provider request failed',
    });
    expect(
      await db.query.organization_domain_claims.findFirst({
        where: eq(organization_domain_claims.domain, 'provider-retry.example.com'),
      })
    ).toMatchObject({ status: 'pending', workos_domain_id: null });

    await expect(caller.organizations.verifiedDomains.create(input)).resolves.toMatchObject({
      claim: { status: 'pending' },
    });
    expect(await claimAuditActions()).toEqual(['organization.domain_claim.create']);
  });

  test('polls and synchronizes verification state with audit transitions', async () => {
    const caller = await createCallerForUser(owner.id);
    const created = await caller.organizations.verifiedDomains.create({
      organizationId: organization.id,
      domain: 'lifecycle.example.com',
    });
    mockWorkOSInstance.organizationDomains.get.mockResolvedValueOnce(
      providerDomain('lifecycle.example.com', OrganizationDomainState.Verified)
    );
    const verified = await caller.organizations.verifiedDomains.refresh({
      organizationId: organization.id,
      claimId: created.claim.id,
    });
    expect(verified.status).toBe('verified');
    expect(verified.verifiedAt).not.toBeNull();

    mockWorkOSInstance.organizationDomains.get.mockResolvedValueOnce(
      providerDomain('lifecycle.example.com', OrganizationDomainState.Failed)
    );
    const pending = await caller.organizations.verifiedDomains.refresh({
      organizationId: organization.id,
      claimId: created.claim.id,
    });
    expect(pending).toMatchObject({ status: 'pending', verifiedAt: null });
    expect(await claimAuditActions()).toEqual([
      'organization.domain_claim.create',
      'organization.domain_claim.verify',
      'organization.domain_claim.lose_verification',
    ]);
    expect(mockWorkOSInstance.organizationDomains.get).toHaveBeenCalledTimes(2);
    expect(mockWorkOSInstance.organizationDomains.verify).not.toHaveBeenCalled();
  });

  test('does not demote a verified claim when the provider refresh fails transiently', async () => {
    mockWorkOSInstance.organizationDomains.create.mockResolvedValueOnce(
      providerDomain('stable.example.com', OrganizationDomainState.Verified)
    );
    const caller = await createCallerForUser(owner.id);
    const created = await caller.organizations.verifiedDomains.create({
      organizationId: organization.id,
      domain: 'stable.example.com',
    });
    mockWorkOSInstance.organizationDomains.get.mockRejectedValueOnce(new Error('timeout'));

    await expect(
      caller.organizations.verifiedDomains.refresh({
        organizationId: organization.id,
        claimId: created.claim.id,
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    expect(
      await db.query.organization_domain_claims.findFirst({
        where: eq(organization_domain_claims.id, created.claim.id),
      })
    ).toMatchObject({ status: 'verified' });
    expect(await claimAuditActions()).toEqual([
      'organization.domain_claim.create',
      'organization.domain_claim.verify',
    ]);
  });

  test('fails cross-organization ownership conflicts generically without contacting WorkOS', async () => {
    const caller = await createCallerForUser(owner.id);
    await caller.organizations.verifiedDomains.create({
      organizationId: organization.id,
      domain: 'owned.example.com',
    });
    jest.clearAllMocks();

    await expect(
      caller.organizations.verifiedDomains.create({
        organizationId: otherOrganization.id,
        domain: 'owned.example.com',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'This domain cannot be claimed' });
    expect(mockWorkOSInstance.organizations.getOrganizationByExternalId).not.toHaveBeenCalled();
  });

  test('maps a provider ID uniqueness race to the generic conflict error', async () => {
    const caller = await createCallerForUser(owner.id);
    await caller.organizations.verifiedDomains.create({
      organizationId: organization.id,
      domain: 'first-provider-id.example.com',
    });
    mockWorkOSInstance.organizationDomains.create.mockResolvedValueOnce({
      ...providerDomain('second-provider-id.example.com'),
      id: 'workos-domain-first-provider-id.example.com',
    });

    await expect(
      caller.organizations.verifiedDomains.create({
        organizationId: organization.id,
        domain: 'second-provider-id.example.com',
      })
    ).rejects.toMatchObject({ code: 'CONFLICT', message: 'This domain cannot be claimed' });
  });

  test('removes only the provider domain and local claim while preserving memberships', async () => {
    const caller = await createCallerForUser(owner.id);
    const created = await caller.organizations.verifiedDomains.create({
      organizationId: organization.id,
      domain: 'remove.example.com',
    });
    const membershipCountBefore = await membershipCount();

    await caller.organizations.verifiedDomains.remove({
      organizationId: organization.id,
      claimId: created.claim.id,
    });

    expect(mockWorkOSInstance.organizationDomains.delete).toHaveBeenCalledWith(
      'workos-domain-remove.example.com'
    );
    expect(mockWorkOSInstance.organizations.deleteOrganization).not.toHaveBeenCalled();
    expect(await membershipCount()).toBe(membershipCountBefore);
    expect(await claimAuditActions()).toEqual([
      'organization.domain_claim.create',
      'organization.domain_claim.remove',
    ]);
  });

  test('preserves authoritative local verification when provider removal fails', async () => {
    mockWorkOSInstance.organizationDomains.create.mockResolvedValueOnce(
      providerDomain('remove-failure.example.com', OrganizationDomainState.Verified)
    );
    const caller = await createCallerForUser(owner.id);
    const created = await caller.organizations.verifiedDomains.create({
      organizationId: organization.id,
      domain: 'remove-failure.example.com',
    });
    mockWorkOSInstance.organizationDomains.delete.mockRejectedValueOnce(new Error('unavailable'));

    await expect(
      caller.organizations.verifiedDomains.remove({
        organizationId: organization.id,
        claimId: created.claim.id,
      })
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      message: 'Domain verification provider request failed',
    });
    expect(
      await db.query.organization_domain_claims.findFirst({
        where: eq(organization_domain_claims.id, created.claim.id),
      })
    ).toMatchObject({ status: 'verified' });
    expect(await claimAuditActions()).toEqual([
      'organization.domain_claim.create',
      'organization.domain_claim.verify',
    ]);
  });

  test('does not let a concurrent refresh resurrect a removed claim', async () => {
    const caller = await createCallerForUser(owner.id);
    const created = await caller.organizations.verifiedDomains.create({
      organizationId: organization.id,
      domain: 'remove-refresh-race.example.com',
    });
    let finishProviderRemoval: (() => void) | undefined;
    const providerRemovalStarted = new Promise<void>(resolve => {
      mockWorkOSInstance.organizationDomains.delete.mockImplementationOnce(
        () =>
          new Promise<void>(finish => {
            finishProviderRemoval = finish;
            resolve();
          })
      );
    });

    const removal = caller.organizations.verifiedDomains.remove({
      organizationId: organization.id,
      claimId: created.claim.id,
    });
    await providerRemovalStarted;
    mockWorkOSInstance.organizationDomains.get.mockResolvedValueOnce(
      providerDomain('remove-refresh-race.example.com', OrganizationDomainState.Verified)
    );
    const refresh = caller.organizations.verifiedDomains.refresh({
      organizationId: organization.id,
      claimId: created.claim.id,
    });
    finishProviderRemoval?.();

    await expect(removal).resolves.toEqual({ success: true });
    await expect(refresh).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      db.query.organization_domain_claims.findFirst({
        where: eq(organization_domain_claims.id, created.claim.id),
      })
    ).resolves.toBeUndefined();
  });

  test('protects a WorkOS organization referenced by claims from SSO deletion and reuses it for setup', async () => {
    const ownerCaller = await createCallerForUser(owner.id);
    await ownerCaller.organizations.verifiedDomains.create({
      organizationId: organization.id,
      domain: 'sso-protection.example.com',
    });
    const adminCaller = await createCallerForUser(kiloAdmin.id);

    await expect(
      adminCaller.organizations.sso.createConfig({ organizationId: organization.id })
    ).resolves.toMatchObject({ id: `workos-${organization.id}` });
    await expect(
      adminCaller.organizations.sso.deleteConfig({ organizationId: organization.id })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockWorkOSInstance.organizations.deleteOrganization).not.toHaveBeenCalled();
  });

  test('does not reuse a verified-domain WorkOS organization as direct SSO for a child', async () => {
    await db
      .update(organizations)
      .set({ parent_organization_id: organization.id })
      .where(eq(organizations.id, otherOrganization.id));
    const ownerCaller = await createCallerForUser(owner.id);

    try {
      await ownerCaller.organizations.verifiedDomains.create({
        organizationId: otherOrganization.id,
        domain: 'child-sso-protection.example.com',
      });
      jest.clearAllMocks();

      const adminCaller = await createCallerForUser(kiloAdmin.id);
      await expect(
        adminCaller.organizations.sso.createConfig({ organizationId: otherOrganization.id })
      ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
      expect(mockWorkOSInstance.organizations.getOrganizationByExternalId).not.toHaveBeenCalled();
    } finally {
      await db
        .update(organizations)
        .set({ parent_organization_id: null })
        .where(eq(organizations.id, otherOrganization.id));
    }
  });

  test('protects SSO deletion while a claim is awaiting provider provisioning', async () => {
    mockWorkOSInstance.organizationDomains.create.mockRejectedValueOnce(new Error('unavailable'));
    const ownerCaller = await createCallerForUser(owner.id);
    await expect(
      ownerCaller.organizations.verifiedDomains.create({
        organizationId: organization.id,
        domain: 'unprovisioned-sso-protection.example.com',
      })
    ).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    const adminCaller = await createCallerForUser(kiloAdmin.id);

    await expect(
      adminCaller.organizations.sso.deleteConfig({ organizationId: organization.id })
    ).rejects.toMatchObject({ code: 'PRECONDITION_FAILED' });
    expect(mockWorkOSInstance.organizations.deleteOrganization).not.toHaveBeenCalled();
  });

  test('preserves SSO deletion when no claim references the WorkOS organization', async () => {
    const adminCaller = await createCallerForUser(kiloAdmin.id);

    await expect(
      adminCaller.organizations.sso.deleteConfig({ organizationId: organization.id })
    ).resolves.toMatchObject({ success: true });
    expect(mockWorkOSInstance.organizations.deleteOrganization).toHaveBeenCalledWith(
      `workos-${organization.id}`
    );
  });

  async function claimAuditActions() {
    const rows = await db
      .select({ action: organization_audit_logs.action })
      .from(organization_audit_logs)
      .where(
        and(
          eq(organization_audit_logs.organization_id, organization.id),
          inArray(organization_audit_logs.action, [
            'organization.domain_claim.create',
            'organization.domain_claim.verify',
            'organization.domain_claim.lose_verification',
            'organization.domain_claim.remove',
          ])
        )
      )
      .orderBy(organization_audit_logs.created_at);
    return rows.map(row => row.action);
  }

  async function membershipCount() {
    const rows = await db
      .select({ userId: organization_memberships.kilo_user_id })
      .from(organization_memberships)
      .where(eq(organization_memberships.organization_id, organization.id));
    return rows.length;
  }
});
