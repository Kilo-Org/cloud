/**
 * The organization Security Agent entry decides between its setup state and
 * the findings dashboard from `organizations.securityAgent.getPermissionStatus`
 * (`hasIntegration`), which resolves the organization's workflow GitHub
 * installation. `githubApps.getInstallation` — the surface every installation
 * screen reads — reports any healthy row the organization owns, whatever its
 * `github_connection_role`.
 *
 * A healthy organization installation left roleless (a pre-`0258` row that
 * `0259` could not rank, or any row written outside the connection writers)
 * therefore disagreed: the app said the organization was connected while the
 * entry gate said connect-GitHub, and the organization's findings were
 * unreachable. `0322` gives those rows the workflow role so both resolutions
 * name the same installation.
 */
import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  agent_configs,
  github_app_installations,
  platform_integrations,
} from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';

import { createCallerForUser } from '@/routers/test-utils';

const BACKFILL_MIGRATION = '0322_github_connection_role_org_backfill.sql';

async function applyConnectionRoleBackfill() {
  const migration = readFileSync(
    resolve(process.cwd(), `../../packages/db/src/migrations/${BACKFILL_MIGRATION}`),
    'utf8'
  );
  await db.execute(sql.raw(migration));
}

describe('organization Security Agent entry for a roleless installation', () => {
  let userId: string;
  let organizationId: string;

  beforeEach(async () => {
    await cleanupDbForTest();
    const user = await insertTestUser({ google_user_email: 'security-entry@example.com' });
    userId = user.id;
    organizationId = (await createTestOrganization('Security entry', userId, 0)).id;
    const [canonical] = await db
      .insert(github_app_installations)
      .values({
        installation_id: '889001',
        github_app_type: 'standard',
        lifecycle_state: 'active',
      })
      .returning();
    await db.insert(platform_integrations).values({
      owned_by_organization_id: organizationId,
      created_by_user_id: userId,
      platform: 'github',
      integration_type: 'app',
      integration_status: 'active',
      platform_installation_id: '889001',
      github_installation_id: canonical.id,
      platform_account_login: 'acme',
      permissions: { vulnerability_alerts: 'read' },
      repository_access: 'all',
      repositories: [{ id: 1, name: 'repo', full_name: 'acme/repo', private: true }],
    });
    await db.insert(agent_configs).values({
      owned_by_organization_id: organizationId,
      agent_type: 'security_scan',
      platform: 'github',
      config: {},
      is_enabled: true,
      created_by: userId,
    });
  });

  afterEach(cleanupDbForTest);

  test('opens the dashboard once the installation carries the workflow role', async () => {
    const caller = await createCallerForUser(userId);
    const input = { organizationId };

    // The defect: the installation surface reports the organization as
    // connected while the entry gate hides the dashboard behind setup.
    expect(await caller.githubApps.getInstallation(input)).toMatchObject({ installed: true });
    expect(await caller.organizations.securityAgent.getPermissionStatus(input)).toMatchObject({
      hasIntegration: false,
    });

    await applyConnectionRoleBackfill();

    expect(await caller.organizations.securityAgent.getPermissionStatus(input)).toMatchObject({
      hasIntegration: true,
      hasPermissions: true,
      integrationId: expect.any(String),
    });
    // The gate and the installation surface must name the same installation.
    const installation = await caller.githubApps.getInstallation(input);
    expect(await caller.organizations.securityAgent.getPermissionStatus(input)).toMatchObject({
      integrationId: installation.installation?.id,
    });
  });
});
