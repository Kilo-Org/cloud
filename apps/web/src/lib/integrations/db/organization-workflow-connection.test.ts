import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { randomInt } from 'node:crypto';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  github_app_installations,
  kilocode_users,
  platform_integrations,
  type PlatformIntegration,
} from '@kilocode/db/schema';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { assertGitHubInstallationRuntimeAuthorized } from '@/lib/integrations/github/runtime-authorization';
import { fetchAllGitHubRepositoriesForOrganization } from '@/lib/cloud-agent/github-integration-helpers';
import {
  getGitHubConnectionStatusForOwner,
  getIntegrationsByOrganization,
  getPrimaryGitHubIntegrationForOrganization,
} from './platform-integrations';

const ownerId = 'oauth/organization-workflow-connection-owner';

let installationIdSequence = randomInt(100_000_000, 900_000_000);
function nextInstallationId() {
  return String(installationIdSequence++);
}

let repositoryIdSequence = 1;

type AssociationScenario = {
  installationId: string;
  role?: 'workflow' | 'agent_only' | null;
  canonicalInstallationId?: string | null;
  createdAt?: string;
  accountLogin?: string;
};

function organizationAssociation(
  organizationId: string,
  scenario: AssociationScenario
): typeof platform_integrations.$inferInsert {
  return {
    owned_by_organization_id: organizationId,
    platform: 'github',
    integration_type: 'app',
    github_connection_role: scenario.role ?? null,
    github_installation_id: scenario.canonicalInstallationId ?? null,
    github_app_type: 'standard',
    platform_installation_id: scenario.installationId,
    platform_account_login: scenario.accountLogin ?? 'acme',
    integration_status: 'active',
    repository_access: 'selected',
    repositories: [
      {
        id: repositoryIdSequence++,
        name: `repo-${scenario.installationId}`,
        full_name: `acme/repo-${scenario.installationId}`,
        private: true,
      },
    ],
    repositories_synced_at: '2026-04-01T00:00:00.000Z',
    created_at: scenario.createdAt,
  };
}

function personalAssociation(
  userId: string,
  scenario: AssociationScenario
): typeof platform_integrations.$inferInsert {
  return {
    ...organizationAssociation('unused', scenario),
    owned_by_organization_id: null,
    owned_by_user_id: userId,
    platform_account_login: scenario.accountLogin ?? 'personal',
  };
}

async function insertAssociation(
  values: typeof platform_integrations.$inferInsert
): Promise<PlatformIntegration> {
  const [row] = await db.insert(platform_integrations).values(values).returning();
  return row;
}

async function insertCanonicalInstallation(installationId: string) {
  const [row] = await db
    .insert(github_app_installations)
    .values({
      installation_id: installationId,
      github_app_type: 'standard',
      lifecycle_state: 'active',
    })
    .returning();
  return row;
}

async function connectionStatus(organizationId: string) {
  return await getGitHubConnectionStatusForOwner({ type: 'org', id: organizationId });
}

async function listedIntegrationIds(organizationId: string, purpose?: 'workflow' | 'agent') {
  const rows = await getIntegrationsByOrganization(
    organizationId,
    'github',
    purpose === undefined ? undefined : purpose
  );
  return rows.map(row => row.id);
}

describe('organization GitHub workflow connection lookups', () => {
  beforeEach(async () => {
    process.env.GITHUB_MULTIPLE_INSTALLATION_ORGANIZATION_IDS = '';
    await cleanupDbForTest();
    await db.insert(kilocode_users).values({
      id: ownerId,
      google_user_email: 'owner@example.com',
      google_user_name: 'Owner',
      google_user_image_url: '',
      stripe_customer_id: 'cus_org_workflow_owner',
    });
  });

  afterEach(cleanupDbForTest);

  test('lists the installation that the organization connection status reports', async () => {
    const organization = await createTestOrganization('Roleless connection', ownerId, 0);
    const installationId = nextInstallationId();
    const association = await insertAssociation(
      organizationAssociation(organization.id, { installationId })
    );

    // The status surface already resolved this association before the change.
    await expect(
      getPrimaryGitHubIntegrationForOrganization(organization.id)
    ).resolves.toMatchObject({ id: association.id });
    await expect(connectionStatus(organization.id)).resolves.toMatchObject({
      connected: true,
      integration: { accountLogin: 'acme' },
    });

    // The same definition now governs the listing, so the repository picker no
    // longer reports "No GitHub integration found" for a connected
    // organization.
    await expect(listedIntegrationIds(organization.id)).resolves.toEqual([association.id]);

    const listed = await fetchAllGitHubRepositoriesForOrganization(organization.id);
    expect(listed.integrationInstalled).toBe(true);
    expect(listed.errorMessage).toBeUndefined();
    expect(listed.repositories).toEqual([
      expect.objectContaining({
        fullName: `acme/repo-${installationId}`,
        platformIntegrationId: association.id,
        platformAccountLogin: 'acme',
      }),
    ]);
  });

  test('keeps a roleless association that another workflow association shadows out of the listing', async () => {
    const organization = await createTestOrganization('Shadowed roleless row', ownerId, 0);
    const installationId = nextInstallationId();
    const claimingOrganization = await createTestOrganization('Claimant', ownerId, 0);
    await insertAssociation(
      organizationAssociation(claimingOrganization.id, {
        installationId,
        role: 'workflow',
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    );
    await insertAssociation(
      organizationAssociation(organization.id, {
        installationId,
        createdAt: '2026-02-01T00:00:00.000Z',
      })
    );

    await expect(connectionStatus(organization.id)).resolves.toEqual({
      connected: false,
      integration: null,
    });
    await expect(listedIntegrationIds(organization.id)).resolves.toEqual([]);
    await expect(fetchAllGitHubRepositoriesForOrganization(organization.id)).resolves.toMatchObject(
      {
        integrationInstalled: false,
        repositories: [],
        errorMessage: 'No GitHub integration found for this organization',
      }
    );
  });

  test('keeps a personal workflow association out of the organization listing', async () => {
    const organization = await createTestOrganization('Claimed by personal', ownerId, 0);
    const installationId = nextInstallationId();
    const personal = await insertAssociation(
      personalAssociation(ownerId, { installationId, role: 'workflow' })
    );
    await insertAssociation(organizationAssociation(organization.id, { installationId }));

    // Migration 0322 counted a claim from any association of the identity, so
    // the installation's connection is the personal one and the organization
    // row stays a shadowed duplicate.
    await expect(connectionStatus(organization.id)).resolves.toEqual({
      connected: false,
      integration: null,
    });
    await expect(listedIntegrationIds(organization.id)).resolves.toEqual([]);

    // Personal lookups keep the stored role, so the personal owner still
    // resolves its own association.
    await expect(
      getGitHubConnectionStatusForOwner({ type: 'user', id: ownerId })
    ).resolves.toMatchObject({ connected: true, integration: { accountLogin: 'personal' } });
    await expect(
      getIntegrationsByOrganization(organization.id, 'github', 'agent')
    ).resolves.toEqual([]);
    expect(personal.github_connection_role).toBe('workflow');
  });

  test('keeps a roleless association whose canonical installation another workflow association claims out of the listing', async () => {
    const organization = await createTestOrganization('Canonical claim', ownerId, 0);
    const claimingOrganization = await createTestOrganization('Canonical claimant', ownerId, 0);
    const installationId = nextInstallationId();
    const canonical = await insertCanonicalInstallation(installationId);
    await insertAssociation(
      organizationAssociation(claimingOrganization.id, {
        installationId: nextInstallationId(),
        role: 'workflow',
        canonicalInstallationId: canonical.id,
      })
    );
    await insertAssociation(
      organizationAssociation(organization.id, {
        installationId,
        canonicalInstallationId: canonical.id,
      })
    );

    await expect(connectionStatus(organization.id)).resolves.toEqual({
      connected: false,
      integration: null,
    });
    await expect(listedIntegrationIds(organization.id)).resolves.toEqual([]);
  });

  test('resolves a roleless association that is bound to its own canonical installation', async () => {
    const organization = await createTestOrganization('Bound roleless row', ownerId, 0);
    const installationId = nextInstallationId();
    const canonical = await insertCanonicalInstallation(installationId);
    const association = await insertAssociation(
      organizationAssociation(organization.id, {
        installationId,
        canonicalInstallationId: canonical.id,
      })
    );

    await expect(listedIntegrationIds(organization.id)).resolves.toEqual([association.id]);
    await expect(connectionStatus(organization.id)).resolves.toMatchObject({ connected: true });
  });

  test('authorizes a runtime token for the connection the listing resolves', async () => {
    const organization = await createTestOrganization('Runtime gate', ownerId, 0);
    const installationId = nextInstallationId();
    const association = await insertAssociation(
      organizationAssociation(organization.id, { installationId })
    );

    // The repository sync behind the picker's refresh mints a token for the
    // listed installation, so the gate it passes must resolve the same row.
    await expect(
      assertGitHubInstallationRuntimeAuthorized(installationId, 'standard', association.id)
    ).resolves.toBeUndefined();

    // Webhook and PR-watch consumers ask by installation alone, without naming
    // the expected association, and must resolve the same connection.
    await expect(
      assertGitHubInstallationRuntimeAuthorized(installationId, 'standard')
    ).resolves.toBeUndefined();
  });

  test('keeps a shadowed roleless association unauthorized for runtime use', async () => {
    const organization = await createTestOrganization('Runtime gate shadowed', ownerId, 0);
    const claimingOrganization = await createTestOrganization('Runtime claimant', ownerId, 0);
    const installationId = nextInstallationId();
    await insertAssociation(
      organizationAssociation(claimingOrganization.id, { installationId, role: 'workflow' })
    );
    const shadowed = await insertAssociation(
      organizationAssociation(organization.id, { installationId })
    );

    await expect(
      assertGitHubInstallationRuntimeAuthorized(installationId, 'standard', shadowed.id)
    ).rejects.toMatchObject({ reason: 'missing_association' });
    await expect(
      assertGitHubInstallationRuntimeAuthorized(installationId, 'standard')
    ).resolves.toBeUndefined();
  });

  test('orders a stored workflow association before an eligible roleless one', async () => {
    const organization = await createTestOrganization('Preference order', ownerId, 0);
    const roleless = await insertAssociation(
      organizationAssociation(organization.id, {
        installationId: nextInstallationId(),
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    );
    const workflow = await insertAssociation(
      organizationAssociation(organization.id, {
        installationId: nextInstallationId(),
        role: 'workflow',
        createdAt: '2026-02-01T00:00:00.000Z',
      })
    );

    await expect(listedIntegrationIds(organization.id)).resolves.toEqual([
      workflow.id,
      roleless.id,
    ]);
    await expect(
      getPrimaryGitHubIntegrationForOrganization(organization.id)
    ).resolves.toMatchObject({ id: workflow.id });
  });

  test('keeps the agent purpose on the stored connection role', async () => {
    const organization = await createTestOrganization('Agent purpose', ownerId, 0);
    await insertAssociation(
      organizationAssociation(organization.id, { installationId: nextInstallationId() })
    );

    await expect(listedIntegrationIds(organization.id, 'workflow')).resolves.toHaveLength(1);
    await expect(listedIntegrationIds(organization.id, 'agent')).resolves.toEqual([]);
  });
});
