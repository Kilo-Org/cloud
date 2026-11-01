/**
 * The organization Security Agent entry decides between its setup state and the
 * findings dashboard from `organizations.securityAgent.getPermissionStatus`
 * (`hasIntegration`), and every command behind that dashboard — repository
 * list, findings, sync, dismissal, analysis — resolves the organization's
 * workflow GitHub connection again. Both sides read the shared organization
 * workflow connection definition (`organizationWorkflowGitHubConnectionSql`),
 * which counts a healthy organization GitHub App association as the workflow
 * connection whether or not its stored connection role was written.
 *
 * The stored role is a denormalized column: every connection writer assigns one,
 * migration `0322` gave it to the healthy organization rows that existed when it
 * ran, but a row written outside those writers (a development seed, an operator
 * statement) or a legacy association linked to its canonical installation after
 * the migration stays roleless. Before the shared definition, such an
 * organization saw the connect-GitHub setup state in the app while every
 * installation surface reported it as connected, and its findings were
 * unreachable.
 */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  agent_configs,
  github_app_installations,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';

import { createCallerForUser } from '@/routers/test-utils';

const BACKFILL_MIGRATION = '0322_github_connection_role_org_backfill.sql';

const REPOSITORY = [{ id: 1, name: 'repo', full_name: 'acme/repo', private: true }];

async function applyConnectionRoleBackfill() {
  const migration = readFileSync(
    resolve(process.cwd(), `../../packages/db/src/migrations/${BACKFILL_MIGRATION}`),
    'utf8'
  );
  await db.execute(sql.raw(migration));
}

async function insertCanonicalInstallation(installationId: string) {
  const [canonical] = await db
    .insert(github_app_installations)
    .values({
      installation_id: installationId,
      github_app_type: 'standard',
      lifecycle_state: 'active',
    })
    .returning();
  return canonical;
}

async function insertOrganizationInstallation(params: {
  organizationId: string;
  installationId: string;
  canonicalId?: string;
  overrides?: Partial<typeof platform_integrations.$inferInsert>;
}) {
  const canonicalId =
    params.canonicalId ?? (await insertCanonicalInstallation(params.installationId)).id;
  const [integration] = await db
    .insert(platform_integrations)
    .values({
      owned_by_organization_id: params.organizationId,
      platform: 'github',
      integration_type: 'app',
      integration_status: 'active',
      platform_installation_id: params.installationId,
      github_installation_id: canonicalId,
      platform_account_login: 'acme',
      permissions: { vulnerability_alerts: 'read' },
      repository_access: 'all',
      repositories: REPOSITORY,
      repositories_synced_at: new Date().toISOString(),
      ...params.overrides,
    })
    .returning();
  return integration;
}

async function insertSecurityAgentConfig(organizationId: string, userId: string) {
  await db.insert(agent_configs).values({
    owned_by_organization_id: organizationId,
    agent_type: 'security_scan',
    platform: 'github',
    config: {},
    is_enabled: true,
    created_by: userId,
  });
}

describe('organization Security Agent entry for the organization workflow connection', () => {
  let userId: string;
  let organizationId: string;

  beforeEach(async () => {
    await cleanupDbForTest();
    const user = await insertTestUser({ google_user_email: 'security-entry@example.com' });
    userId = user.id;
    organizationId = (await createTestOrganization('Security entry', userId, 0)).id;
    await insertSecurityAgentConfig(organizationId, userId);
  });

  afterEach(cleanupDbForTest);

  test('opens the dashboard for a healthy installation written without a role', async () => {
    const integration = await insertOrganizationInstallation({
      organizationId,
      installationId: '889001',
    });
    expect(integration.github_connection_role).toBeNull();

    const caller = await createCallerForUser(userId);
    const input = { organizationId };

    // The installation surface has always reported this organization as
    // connected; the entry gate and the commands behind it must agree.
    expect(await caller.githubApps.getInstallation(input)).toMatchObject({
      installed: true,
      installation: { id: integration.id },
    });
    expect(await caller.organizations.securityAgent.getPermissionStatus(input)).toMatchObject({
      hasIntegration: true,
      hasPermissions: true,
      integrationId: integration.id,
      reauthorizeUrl: null,
    });
    // An operation behind the dashboard resolves the same installation.
    expect(await caller.organizations.securityAgent.getRepositories(input)).toMatchObject([
      { fullName: 'acme/repo' },
    ]);
  });

  test('opens the dashboard for a roleless installation written after the role backfill', async () => {
    await applyConnectionRoleBackfill();
    const integration = await insertOrganizationInstallation({
      organizationId,
      installationId: '889002',
    });

    const caller = await createCallerForUser(userId);
    expect(
      await caller.organizations.securityAgent.getPermissionStatus({ organizationId })
    ).toMatchObject({ hasIntegration: true, integrationId: integration.id });
  });

  test('keeps the setup state for a shared installation’s secondary organization', async () => {
    // The other owner holds this installation's workflow claim, so this
    // organization's association is an `agent_only` sharing row and the
    // Security Agent does not run for it.
    const primaryOrganizationId = (await createTestOrganization('Primary', userId, 0)).id;
    const canonical = await insertCanonicalInstallation('889003');
    await insertOrganizationInstallation({
      organizationId: primaryOrganizationId,
      installationId: '889003',
      canonicalId: canonical.id,
      overrides: { github_connection_role: 'workflow' },
    });
    await insertSecurityAgentConfig(primaryOrganizationId, userId);
    await insertOrganizationInstallation({
      organizationId,
      installationId: '889003',
      canonicalId: canonical.id,
      overrides: { github_connection_role: 'agent_only' },
    });

    const caller = await createCallerForUser(userId);
    expect(
      await caller.organizations.securityAgent.getPermissionStatus({ organizationId })
    ).toMatchObject({ hasIntegration: false });
    expect(
      await caller.organizations.securityAgent.getPermissionStatus({
        organizationId: primaryOrganizationId,
      })
    ).toMatchObject({ hasIntegration: true });
  });

  test('keeps the setup state for a roleless row another association claims', async () => {
    // A shadowed duplicate: the claim belongs to the other owner, so this
    // association stays out of the workflow lookups.
    const primaryOrganizationId = (await createTestOrganization('Primary', userId, 0)).id;
    const canonical = await insertCanonicalInstallation('889004');
    await insertOrganizationInstallation({
      organizationId: primaryOrganizationId,
      installationId: '889004',
      canonicalId: canonical.id,
      overrides: { github_connection_role: 'workflow' },
    });
    await insertOrganizationInstallation({
      organizationId,
      installationId: '889004',
      canonicalId: canonical.id,
    });

    const caller = await createCallerForUser(userId);
    expect(
      await caller.organizations.securityAgent.getPermissionStatus({ organizationId })
    ).toMatchObject({ hasIntegration: false });
  });

  test('keeps the setup state for a roleless installation that is not healthy', async () => {
    await insertOrganizationInstallation({
      organizationId,
      installationId: '889005',
      overrides: {
        github_disconnected_at: new Date().toISOString(),
        integration_status: 'suspended',
      },
    });

    const caller = await createCallerForUser(userId);
    expect(
      await caller.organizations.securityAgent.getPermissionStatus({ organizationId })
    ).toMatchObject({ hasIntegration: false });
  });

  test('keeps the setup state for a personal installation without a role', async () => {
    await db.insert(platform_integrations).values({
      owned_by_user_id: userId,
      platform: 'github',
      integration_type: 'app',
      integration_status: 'active',
      platform_installation_id: '889006',
      platform_account_login: 'personal',
      permissions: { vulnerability_alerts: 'read' },
      repository_access: 'all',
      repositories: REPOSITORY,
    });

    const caller = await createCallerForUser(userId);
    expect(await caller.securityAgent.getPermissionStatus()).toMatchObject({
      hasIntegration: false,
    });
  });

  test('gives the row its stored role when the connection role backfill runs', async () => {
    const integration = await insertOrganizationInstallation({
      organizationId,
      installationId: '889007',
    });

    await applyConnectionRoleBackfill();

    const [repaired] = await db
      .select({ role: platform_integrations.github_connection_role })
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integration.id));
    expect(repaired?.role).toBe('workflow');
  });
});
