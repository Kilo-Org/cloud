import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { github_app_installations, platform_integrations } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

import {
  getIntegrationForOrganization,
  getPrimaryGitHubIntegrationForOrganization,
} from './platform-integrations';

const ownerId = 'oauth/github-role-backfill-owner';

const BACKFILL_MIGRATION = '0321_github_connection_role_org_backfill.sql';

async function applyConnectionRoleBackfill() {
  const migration = readFileSync(
    resolve(process.cwd(), `../../packages/db/src/migrations/${BACKFILL_MIGRATION}`),
    'utf8'
  );
  await db.execute(sql.raw(migration));
}

const installation = (installationId: string) => ({
  installation_id: installationId,
  github_app_type: 'standard' as const,
  lifecycle_state: 'active' as const,
});

const organizationIntegration = (
  organizationId: string,
  installationId: string,
  overrides: Partial<typeof platform_integrations.$inferInsert> = {}
): typeof platform_integrations.$inferInsert => ({
  owned_by_organization_id: organizationId,
  created_by_user_id: ownerId,
  platform: 'github',
  integration_type: 'app',
  integration_status: 'active',
  platform_installation_id: installationId,
  platform_account_login: 'acme',
  permissions: { vulnerability_alerts: 'read' },
  repository_access: 'all',
  repositories: [{ id: 1, name: 'repo', full_name: 'acme/repo', private: true }],
  ...overrides,
});

async function readRole(id: string) {
  const [row] = await db
    .select({ role: platform_integrations.github_connection_role })
    .from(platform_integrations)
    .where(eq(platform_integrations.id, id));
  return row?.role ?? null;
}

describe('organization GitHub installation role backfill', () => {
  let organizationA: string;
  let organizationB: string;

  beforeEach(async () => {
    await cleanupDbForTest();
    await insertTestUser({ id: ownerId, email: 'role-backfill@example.com' });
    organizationA = (await createTestOrganization('Role backfill A', ownerId, 0)).id;
    organizationB = (await createTestOrganization('Role backfill B', ownerId, 0)).id;
  });

  afterEach(cleanupDbForTest);

  test('gives a healthy organization installation without a role the workflow connection', async () => {
    const [canonical] = await db
      .insert(github_app_installations)
      .values(installation('880001'))
      .returning();
    const [row] = await db
      .insert(platform_integrations)
      .values(
        organizationIntegration(organizationA, '880001', { github_installation_id: canonical.id })
      )
      .returning();

    await applyConnectionRoleBackfill();

    expect(await readRole(row.id)).toBe('workflow');
    // The defect was a disagreement: the entry gate and every operational
    // lookup must resolve the same installation.
    const statusIntegration = await getIntegrationForOrganization(organizationA, 'github');
    const primaryIntegration = await getPrimaryGitHubIntegrationForOrganization(organizationA);
    expect(statusIntegration?.id).toBe(row.id);
    expect(primaryIntegration?.id).toBe(row.id);
  });

  test('repairs an unbound legacy installation that has no canonical record yet', async () => {
    const [row] = await db
      .insert(platform_integrations)
      .values(organizationIntegration(organizationA, '880002'))
      .returning();

    await applyConnectionRoleBackfill();

    expect(await readRole(row.id)).toBe('workflow');
  });

  test.each([
    ['a locally disconnected installation', { github_disconnected_at: new Date().toISOString() }],
    ['a suspended installation', { suspended_at: new Date().toISOString() }],
    ['an auth-invalid installation', { auth_invalid_at: new Date().toISOString() }],
    ['an inactive installation', { integration_status: 'suspended' as const }],
  ])('leaves %s on the connect-GitHub gate', async (_label, overrides) => {
    const [row] = await db
      .insert(platform_integrations)
      .values(organizationIntegration(organizationA, '880003', overrides))
      .returning();

    await applyConnectionRoleBackfill();

    expect(await readRole(row.id)).toBeNull();
    expect(await getPrimaryGitHubIntegrationForOrganization(organizationA)).toBeNull();
  });

  test('leaves an installation id GitHub never issued untouched', async () => {
    const [row] = await db
      .insert(platform_integrations)
      .values(organizationIntegration(organizationA, 'seed_github_fixture'))
      .returning();

    await applyConnectionRoleBackfill();

    expect(await readRole(row.id)).toBeNull();
  });

  test('leaves a personal installation untouched', async () => {
    const [row] = await db
      .insert(platform_integrations)
      .values(
        organizationIntegration(organizationA, '880004', {
          owned_by_organization_id: null,
          owned_by_user_id: ownerId,
        })
      )
      .returning();

    await applyConnectionRoleBackfill();

    expect(await readRole(row.id)).toBeNull();
  });

  test('does not shadow an organization that already holds the workflow connection', async () => {
    const [canonical] = await db
      .insert(github_app_installations)
      .values(installation('880005'))
      .returning();
    const [claimed] = await db
      .insert(platform_integrations)
      .values(
        organizationIntegration(organizationA, '880005', {
          github_installation_id: canonical.id,
          github_connection_role: 'workflow',
        })
      )
      .returning();
    const [roleless] = await db
      .insert(platform_integrations)
      .values(
        organizationIntegration(organizationB, '880005', { github_installation_id: canonical.id })
      )
      .returning();

    await applyConnectionRoleBackfill();

    expect(await readRole(claimed.id)).toBe('workflow');
    expect(await readRole(roleless.id)).toBeNull();
  });

  test('assigns the role to one owner only when two roleless organizations share an installation', async () => {
    const [oldest] = await db
      .insert(platform_integrations)
      .values(
        organizationIntegration(organizationA, '880006', {
          created_at: '2026-01-01T00:00:00.000Z',
        })
      )
      .returning();
    const [newest] = await db
      .insert(platform_integrations)
      .values(
        organizationIntegration(organizationB, '880006', {
          created_at: '2026-02-01T00:00:00.000Z',
        })
      )
      .returning();

    await applyConnectionRoleBackfill();

    expect(await readRole(oldest.id)).toBe('workflow');
    expect(await readRole(newest.id)).toBeNull();
  });
});
