jest.mock('@workos-inc/node', () => {
  const mockWorkOSInstance = {
    organizations: {
      getOrganizationByExternalId: jest.fn(),
      deleteOrganization: jest.fn(),
    },
    sso: {
      listConnections: jest.fn(),
    },
  };

  return {
    WorkOS: jest.fn(() => mockWorkOSInstance),
    GenerateLinkIntent: { SSO: 'sso', DomainVerification: 'domain-verification' },
    OrganizationDomainState: { Verified: 'verified', Pending: 'pending', Unverified: 'unverified' },
    mockWorkOSInstance,
  };
});

import { afterAll, beforeAll, beforeEach, describe, expect, test } from '@jest/globals';
import { and, eq } from 'drizzle-orm';

import {
  admin_action_audit_logs,
  kilocode_users,
  organization_audit_logs,
  organization_memberships,
  organizations,
  support_access_grants,
  type Organization,
  type User,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { createOrganization } from '@kilocode/web-shared/lib/organizations/organizations';
import { resolveSsoAuthorityForDomain } from '@kilocode/web-shared/lib/organizations/organization-sso-policy';
import { createCallerForUser } from '@/routers/test-utils';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

const { mockWorkOSInstance } = jest.requireMock('@workos-inc/node') as {
  mockWorkOSInstance: {
    organizations: {
      getOrganizationByExternalId: jest.Mock;
      deleteOrganization: jest.Mock;
    };
    sso: {
      listConnections: jest.Mock;
    };
  };
};

const getOrganizationByExternalId = mockWorkOSInstance.organizations.getOrganizationByExternalId;
const deleteOrganization = mockWorkOSInstance.organizations.deleteOrganization;
const listConnections = mockWorkOSInstance.sso.listConnections;

describe('organization SSO router', () => {
  let admin: User;
  let sameDomainUser: User;
  let organization: Organization;

  beforeAll(async () => {
    admin = await insertTestUser({
      google_user_email: 'sso-admin@admin.example.com',
      is_admin: true,
    });
    sameDomainUser = await insertTestUser({
      google_user_email: 'member@example.com',
      api_token_pepper: 'old-api-pepper',
      web_session_pepper: 'old-web-pepper',
    });
    organization = await createOrganization('SSO Router Organization', admin.id);
  });

  afterAll(async () => {
    await db.delete(organizations).where(eq(organizations.id, organization.id));
  });

  const createdOrganizationIds: string[] = [];

  async function createSsoOrganization(name: string, ssoDomain: string | null) {
    const created = await createOrganization(name, admin.id);
    createdOrganizationIds.push(created.id);
    if (ssoDomain) {
      await db
        .update(organizations)
        .set({ sso_domain: ssoDomain })
        .where(eq(organizations.id, created.id));
    }
    return created;
  }

  async function readSsoDomain(organizationId: string) {
    const row = await db.query.organizations.findFirst({
      where: eq(organizations.id, organizationId),
      columns: { sso_domain: true },
    });
    return row?.sso_domain ?? null;
  }

  async function readDomainAudits(organizationId: string) {
    return db
      .select({
        action: organization_audit_logs.action,
        actor_id: organization_audit_logs.actor_id,
        message: organization_audit_logs.message,
      })
      .from(organization_audit_logs)
      .where(eq(organization_audit_logs.organization_id, organizationId));
  }

  afterAll(async () => {
    for (const organizationId of createdOrganizationIds) {
      await db
        .delete(organization_audit_logs)
        .where(eq(organization_audit_logs.organization_id, organizationId));
      await db
        .delete(admin_action_audit_logs)
        .where(eq(admin_action_audit_logs.target_id, organizationId));
      await db.delete(organizations).where(eq(organizations.id, organizationId));
    }
  });

  test('does not eagerly rotate same-domain credentials when SSO is enabled', async () => {
    const caller = await createCallerForUser(admin.id);

    await caller.organizations.sso.updateSsoDomain({
      organizationId: organization.id,
      ssoDomain: 'example.com',
    });

    const updatedUser = await db.query.kilocode_users.findFirst({
      where: eq(kilocode_users.id, sameDomainUser.id),
    });

    expect(updatedUser?.api_token_pepper).toBe('old-api-pepper');
    expect(updatedUser?.web_session_pepper).toBe('old-web-pepper');
  });

  describe('getConfig', () => {
    const callers: User[] = [];
    const originalSupportAccessEnabled = process.env.SUPPORT_ACCESS_ENABLED;

    beforeAll(() => {
      // Support access off is the default deployment state and the state these expectations
      // describe, where a Kilo staff caller resolves to the legacy admin access.
      process.env.SUPPORT_ACCESS_ENABLED = 'false';
    });

    afterAll(() => {
      if (originalSupportAccessEnabled === undefined) {
        delete process.env.SUPPORT_ACCESS_ENABLED;
      } else {
        process.env.SUPPORT_ACCESS_ENABLED = originalSupportAccessEnabled;
      }
    });

    async function createCallerWithRole(role: 'member' | 'admin' | 'owner') {
      const user = await insertTestUser({
        google_user_email: `sso-read-${role}-${crypto.randomUUID()}@example.com`,
      });
      callers.push(user);
      await db.insert(organization_memberships).values({
        organization_id: organization.id,
        kilo_user_id: user.id,
        role,
      });
      return createCallerForUser(user.id);
    }

    afterAll(async () => {
      for (const user of callers) {
        await db
          .delete(organization_memberships)
          .where(eq(organization_memberships.kilo_user_id, user.id));
        await db.delete(kilocode_users).where(eq(kilocode_users.id, user.id));
      }
    });

    beforeEach(() => {
      getOrganizationByExternalId.mockReset();
      listConnections.mockReset();
      listConnections.mockResolvedValue({ data: [{ id: 'connection_read' }] });
      getOrganizationByExternalId.mockResolvedValue({
        object: 'organization',
        id: 'workos_org_read',
        name: 'Read SSO Organization',
        allowProfilesOutsideOrganization: false,
        domains: [
          {
            object: 'organization_domain',
            id: 'workos_org_domain_read',
            domain: 'read-sso.test',
            organizationId: 'workos_org_read',
            state: 'verified',
            verificationToken: 'domain-verification-token',
            verificationStrategy: 'dns',
            verificationPrefix: 'workos-verify',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        stripeCustomerId: 'cus_read_sso',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        externalId: organization.id,
        metadata: {
          createdById: 'sso-config-creator',
          createdByEmail: 'sso-config-creator@example.com',
        },
      });
    });

    test('returns the status summary to an organization member', async () => {
      const caller = await createCallerWithRole('member');

      const result = await caller.organizations.sso.getConfig({
        organizationId: organization.id,
      });

      expect(result).toEqual({
        kind: 'status',
        isDomainVerified: true,
        hasConnection: true,
        domain: 'read-sso.test',
      });
      expect(JSON.stringify(result)).not.toContain('workos_org_read');
      expect(JSON.stringify(result)).not.toContain('cus_read_sso');
      expect(JSON.stringify(result)).not.toContain('domain-verification-token');
      expect(JSON.stringify(result)).not.toContain('sso-config-creator');
    });

    test('returns the provider configuration to an organization owner', async () => {
      const caller = await createCallerWithRole('owner');

      const result = await caller.organizations.sso.getConfig({
        organizationId: organization.id,
      });

      expect(result).toEqual({
        kind: 'configuration',
        isDomainVerified: true,
        hasConnection: true,
        domain: 'read-sso.test',
        workosOrganization: {
          id: 'workos_org_read',
          name: 'Read SSO Organization',
          domains: [{ domain: 'read-sso.test', state: 'verified' }],
        },
      });
    });

    test('returns the provider configuration to an organization admin', async () => {
      const caller = await createCallerWithRole('admin');

      const result = await caller.organizations.sso.getConfig({
        organizationId: organization.id,
      });

      expect(result).toEqual({
        kind: 'configuration',
        isDomainVerified: true,
        hasConnection: true,
        domain: 'read-sso.test',
        workosOrganization: {
          id: 'workos_org_read',
          name: 'Read SSO Organization',
          domains: [{ domain: 'read-sso.test', state: 'verified' }],
        },
      });
    });

    test('returns the provider configuration to a Kilo admin outside the organization', async () => {
      const kiloAdmin = await insertTestUser({
        google_user_email: `sso-read-kilo-admin-${crypto.randomUUID()}@example.com`,
        is_admin: true,
      });
      callers.push(kiloAdmin);
      const caller = await createCallerForUser(kiloAdmin.id);

      const result = await caller.organizations.sso.getConfig({
        organizationId: organization.id,
      });

      expect(result).toEqual({
        kind: 'configuration',
        isDomainVerified: true,
        hasConnection: true,
        domain: 'read-sso.test',
        workosOrganization: {
          id: 'workos_org_read',
          name: 'Read SSO Organization',
          domains: [{ domain: 'read-sso.test', state: 'verified' }],
        },
      });
    });

    test('returns false when the organization has no WorkOS configuration', async () => {
      const caller = await createCallerWithRole('member');
      getOrganizationByExternalId.mockResolvedValue(null);

      await expect(
        caller.organizations.sso.getConfig({ organizationId: organization.id })
      ).resolves.toBe(false);
      expect(listConnections).not.toHaveBeenCalled();
    });

    test('returns the status summary to an active support read', async () => {
      const staff = await insertTestUser({
        google_user_email: `sso-read-support-${crypto.randomUUID()}@example.com`,
        is_admin: true,
      });
      callers.push(staff);
      const now = new Date();
      const grant = await db
        .insert(support_access_grants)
        .values({
          actor_kilo_user_id: staff.id,
          organization_id: organization.id,
          action_class: 'support_read',
          status: 'active',
          reason: 'investigating a customer report',
          requested_duration_seconds: 1800,
          issued_at: now.toISOString(),
          expires_at: new Date(now.getTime() + 30 * 60 * 1000).toISOString(),
        })
        .returning({ id: support_access_grants.id });
      process.env.SUPPORT_ACCESS_ENABLED = 'true';
      try {
        const caller = await createCallerForUser(staff.id);

        const result = await caller.organizations.sso.getConfig({
          organizationId: organization.id,
        });

        expect(result).toEqual({
          kind: 'status',
          isDomainVerified: true,
          hasConnection: true,
          domain: 'read-sso.test',
        });
      } finally {
        process.env.SUPPORT_ACCESS_ENABLED = 'false';
        await db.delete(support_access_grants).where(eq(support_access_grants.id, grant[0].id));
      }
    });

    test('names the verified domain in the summary when several are configured', async () => {
      const caller = await createCallerWithRole('member');
      const verifiedDomain = {
        object: 'organization_domain',
        id: 'workos_org_domain_read',
        domain: 'read-sso.test',
        organizationId: 'workos_org_read',
        state: 'verified',
        verificationStrategy: 'dns',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      };
      getOrganizationByExternalId.mockResolvedValue({
        object: 'organization',
        id: 'workos_org_read',
        name: 'Read SSO Organization',
        allowProfilesOutsideOrganization: false,
        domains: [
          {
            ...verifiedDomain,
            id: 'workos_org_domain_pending',
            domain: 'pending-sso.test',
            state: 'pending',
          },
          verifiedDomain,
        ],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        externalId: organization.id,
        metadata: {},
      });

      await expect(
        caller.organizations.sso.getConfig({ organizationId: organization.id })
      ).resolves.toEqual({
        kind: 'status',
        isDomainVerified: true,
        hasConnection: true,
        domain: 'read-sso.test',
      });
    });
  });

  describe('deleteConfig', () => {
    async function readAdminActions(organizationId: string) {
      return db
        .select({
          action: admin_action_audit_logs.action,
          metadata: admin_action_audit_logs.metadata,
        })
        .from(admin_action_audit_logs)
        .where(
          and(
            eq(admin_action_audit_logs.action, 'organization.sso.config.delete'),
            eq(admin_action_audit_logs.target_id, organizationId)
          )
        );
    }

    beforeEach(() => {
      getOrganizationByExternalId.mockReset();
      deleteOrganization.mockReset();
      getOrganizationByExternalId.mockResolvedValue(null);
      deleteOrganization.mockResolvedValue({});
    });

    test('releases the SSO domain together with the WorkOS configuration', async () => {
      const caller = await createCallerForUser(admin.id);
      const target = await createSsoOrganization('Deleted SSO Organization', 'deleted-sso.test');
      getOrganizationByExternalId.mockResolvedValue({
        id: 'workos_org_deleted',
        externalId: target.id,
        domains: [],
      });

      await caller.organizations.sso.deleteConfig({ organizationId: target.id });

      expect(deleteOrganization).toHaveBeenCalledWith('workos_org_deleted');
      await expect(readSsoDomain(target.id)).resolves.toBeNull();
      await expect(readDomainAudits(target.id)).resolves.toEqual([
        {
          action: 'organization.sso.remove_domain',
          actor_id: admin.id,
          message: 'Cleared SSO domain deleted-sso.test',
        },
      ]);
      await expect(readAdminActions(target.id)).resolves.toEqual([
        {
          action: 'organization.sso.config.delete',
          metadata: {
            workosOrganizationId: 'workos_org_deleted',
          },
        },
      ]);
      await expect(resolveSsoAuthorityForDomain('deleted-sso.test')).resolves.toEqual({
        status: 'not_required',
        domain: 'deleted-sso.test',
      });
    });

    test('removes a WorkOS configuration that has no recorded domain', async () => {
      const caller = await createCallerForUser(admin.id);
      const target = await createSsoOrganization('WorkOS Only Organization', null);
      getOrganizationByExternalId.mockResolvedValue({
        id: 'workos_org_only',
        externalId: target.id,
        domains: [],
      });

      await caller.organizations.sso.deleteConfig({ organizationId: target.id });

      expect(deleteOrganization).toHaveBeenCalledWith('workos_org_only');
      await expect(readSsoDomain(target.id)).resolves.toBeNull();
      await expect(readDomainAudits(target.id)).resolves.toEqual([]);
      await expect(readAdminActions(target.id)).resolves.toEqual([
        {
          action: 'organization.sso.config.delete',
          metadata: { workosOrganizationId: 'workos_org_only' },
        },
      ]);
    });

    test('lets another organization claim the released domain', async () => {
      const caller = await createCallerForUser(admin.id);
      const released = await createSsoOrganization('Released Domain Organization', 'released.test');
      getOrganizationByExternalId.mockResolvedValue({
        id: 'workos_org_released',
        externalId: released.id,
        domains: [],
      });
      const claimant = await createSsoOrganization('Claiming Organization', null);

      await caller.organizations.sso.deleteConfig({ organizationId: released.id });
      await caller.organizations.sso.updateSsoDomain({
        organizationId: claimant.id,
        ssoDomain: 'released.test',
      });

      await expect(readSsoDomain(claimant.id)).resolves.toBe('released.test');
      await expect(resolveSsoAuthorityForDomain('released.test')).resolves.toEqual({
        status: 'required',
        domain: 'released.test',
        sourceOrganizationId: claimant.id,
      });
    });

    test('leaves the SSO state unchanged when the WorkOS deletion fails', async () => {
      const caller = await createCallerForUser(admin.id);
      const target = await createSsoOrganization(
        'WorkOS Failure Organization',
        'workos-failure.test'
      );
      getOrganizationByExternalId.mockResolvedValue({
        id: 'workos_org_failure',
        externalId: target.id,
        domains: [],
      });
      deleteOrganization.mockRejectedValue(new Error('WorkOS is unavailable'));

      await expect(
        caller.organizations.sso.deleteConfig({ organizationId: target.id })
      ).rejects.toThrow('WorkOS is unavailable');

      await expect(readSsoDomain(target.id)).resolves.toBe('workos-failure.test');
      await expect(readDomainAudits(target.id)).resolves.toEqual([]);
      await expect(readAdminActions(target.id)).resolves.toEqual([]);
    });

    test('refuses to delete when the organization has no SSO configuration', async () => {
      const caller = await createCallerForUser(admin.id);
      const target = await createSsoOrganization('Unconfigured Organization', null);

      await expect(
        caller.organizations.sso.deleteConfig({ organizationId: target.id })
      ).rejects.toMatchObject({
        code: 'NOT_FOUND',
        message: 'SSO configuration not found',
      });

      expect(deleteOrganization).not.toHaveBeenCalled();
      await expect(readDomainAudits(target.id)).resolves.toEqual([]);
    });

    test('releases a leftover SSO domain when the WorkOS configuration is already gone', async () => {
      const caller = await createCallerForUser(admin.id);
      const target = await createSsoOrganization('Leftover Domain Organization', 'leftover.test');

      await caller.organizations.sso.deleteConfig({ organizationId: target.id });

      expect(deleteOrganization).not.toHaveBeenCalled();
      await expect(readSsoDomain(target.id)).resolves.toBeNull();
      await expect(readDomainAudits(target.id)).resolves.toEqual([
        {
          action: 'organization.sso.remove_domain',
          actor_id: admin.id,
          message: 'Cleared SSO domain leftover.test',
        },
      ]);
      await expect(readAdminActions(target.id)).resolves.toEqual([]);
      await expect(resolveSsoAuthorityForDomain('leftover.test')).resolves.toEqual({
        status: 'not_required',
        domain: 'leftover.test',
      });
    });
  });

  describe('clearSsoDomain', () => {
    test('releases the recorded domain and lets another organization claim it', async () => {
      const caller = await createCallerForUser(admin.id);
      const target = await createSsoOrganization('Cleared Domain Organization', 'cleared.test');

      await caller.organizations.sso.clearSsoDomain({ organizationId: target.id });

      await expect(readSsoDomain(target.id)).resolves.toBeNull();
      await expect(readDomainAudits(target.id)).resolves.toEqual([
        {
          action: 'organization.sso.remove_domain',
          actor_id: admin.id,
          message: 'Cleared SSO domain cleared.test',
        },
      ]);
      await expect(resolveSsoAuthorityForDomain('cleared.test')).resolves.toEqual({
        status: 'not_required',
        domain: 'cleared.test',
      });
    });

    test('writes nothing when the organization records no domain', async () => {
      const caller = await createCallerForUser(admin.id);
      const target = await createSsoOrganization('Empty Domain Organization', null);

      await caller.organizations.sso.clearSsoDomain({ organizationId: target.id });

      await expect(readSsoDomain(target.id)).resolves.toBeNull();
      await expect(readDomainAudits(target.id)).resolves.toEqual([]);
    });
  });
});
