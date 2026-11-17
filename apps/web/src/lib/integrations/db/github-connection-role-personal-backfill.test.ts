import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { github_app_installations, platform_integrations } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';

import { fetchGitHubRepositoriesForUser } from '@/lib/cloud-agent/github-integration-helpers';
import { assertGitHubInstallationRuntimeAuthorized } from '@/lib/integrations/github/runtime-authorization';

const userId = 'oauth/github-personal-role-backfill';
const otherUserId = 'oauth/github-personal-role-backfill-other';

const BACKFILL_MIGRATION = '0363_github_connection_role_personal_backfill.sql';

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

const REPOSITORIES = [
  { id: 4101, name: 'alpha', full_name: 'acme/alpha', private: true },
  { id: 4102, name: 'beta', full_name: 'acme/beta', private: false },
  { id: 4103, name: 'gamma', full_name: 'acme/gamma', private: true },
];

const personalIntegration = (
  installationId: string,
  overrides: Partial<typeof platform_integrations.$inferInsert> = {}
): typeof platform_integrations.$inferInsert => ({
  owned_by_user_id: userId,
  created_by_user_id: userId,
  platform: 'github',
  integration_type: 'app',
  integration_status: 'active',
  platform_installation_id: installationId,
  platform_account_login: 'acme',
  permissions: { vulnerability_alerts: 'read' },
  repository_access: 'all',
  github_app_type: 'standard',
  repositories: REPOSITORIES,
  repositories_synced_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
  ...overrides,
});

async function readRole(id: string) {
  const [row] = await db
    .select({ role: platform_integrations.github_connection_role })
    .from(platform_integrations)
    .where(eq(platform_integrations.id, id));
  return row?.role ?? null;
}

describe('personal GitHub installation role backfill', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    await insertTestUser({ id: userId, google_user_email: 'personal-role@example.com' });
    await insertTestUser({ id: otherUserId, google_user_email: 'personal-role-2@example.com' });
  });

  afterEach(cleanupDbForTest);

  test('repairs a healthy personal installation so the composer read and the runtime agree', async () => {
    const [row] = await db
      .insert(platform_integrations)
      .values(personalIntegration('890001'))
      .returning();

    // The reported state: a stored, healthy integration whose cached
    // repositories cannot be read because the association has no role.
    await expect(fetchGitHubRepositoriesForUser(userId)).resolves.toMatchObject({
      integrationInstalled: false,
      repositories: [],
    });
    await expect(
      assertGitHubInstallationRuntimeAuthorized('890001', 'standard', row.id, 'agent')
    ).rejects.toThrow();

    await applyConnectionRoleBackfill();

    expect(await readRole(row.id)).toBe('workflow');
    const result = await fetchGitHubRepositoriesForUser(userId);
    expect(result.integrationInstalled).toBe(true);
    expect(result.repositories.map(repository => repository.fullName)).toEqual([
      'acme/alpha',
      'acme/beta',
      'acme/gamma',
    ]);
    await expect(
      assertGitHubInstallationRuntimeAuthorized('890001', 'standard', row.id, 'agent')
    ).resolves.toBeUndefined();
  });

  test('repairs a personal installation already bound to its canonical record', async () => {
    const [canonical] = await db
      .insert(github_app_installations)
      .values(installation('890002'))
      .returning();
    const [row] = await db
      .insert(platform_integrations)
      .values(personalIntegration('890002', { github_installation_id: canonical.id }))
      .returning();

    await applyConnectionRoleBackfill();

    expect(await readRole(row.id)).toBe('workflow');
  });

  test('keeps a personal installation whose canonical record is not live', async () => {
    const [canonical] = await db
      .insert(github_app_installations)
      .values({
        ...installation('890003'),
        lifecycle_state: 'deleted' as const,
      })
      .returning();
    const [row] = await db
      .insert(platform_integrations)
      .values(personalIntegration('890003', { github_installation_id: canonical.id }))
      .returning();

    await applyConnectionRoleBackfill();

    expect(await readRole(row.id)).toBeNull();
  });

  test('keeps a personal installation another owner already claims for the workflow role', async () => {
    const organization = await createTestOrganization('Role backfill claim', otherUserId, 0);
    await db.insert(platform_integrations).values({
      owned_by_organization_id: organization.id,
      created_by_user_id: otherUserId,
      platform: 'github',
      integration_type: 'app',
      integration_status: 'active',
      platform_installation_id: '890004',
      platform_account_login: 'acme',
      github_app_type: 'standard',
      github_connection_role: 'workflow',
      repositories: REPOSITORIES,
      repositories_synced_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
    });
    const [row] = await db
      .insert(platform_integrations)
      .values(personalIntegration('890004'))
      .returning();

    await applyConnectionRoleBackfill();

    expect(await readRole(row.id)).toBeNull();
  });

  test.each([
    ['a locally disconnected installation', { github_disconnected_at: new Date().toISOString() }],
    ['a suspended installation', { suspended_at: new Date().toISOString() }],
    ['an auth-invalid installation', { auth_invalid_at: new Date().toISOString() }],
    ['an inactive installation', { integration_status: 'suspended' as const }],
  ])('leaves %s on the connect-GitHub gate', async (_label, overrides) => {
    const [row] = await db
      .insert(platform_integrations)
      .values(personalIntegration('890005', overrides))
      .returning();

    await applyConnectionRoleBackfill();

    expect(await readRole(row.id)).toBeNull();
  });

  test('leaves a roleless organization installation to the organization backfill', async () => {
    const organization = await createTestOrganization('Role backfill org', otherUserId, 0);
    const [row] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: organization.id,
        created_by_user_id: otherUserId,
        platform: 'github',
        integration_type: 'app',
        integration_status: 'active',
        platform_installation_id: '890006',
        platform_account_login: 'acme',
        github_app_type: 'standard',
        repositories: REPOSITORIES,
        repositories_synced_at: new Date('2026-01-01T00:00:00.000Z').toISOString(),
      })
      .returning();

    await applyConnectionRoleBackfill();

    expect(await readRole(row.id)).toBeNull();
  });

  test('classifies only one association per installation identity', async () => {
    // Two users associated with one installation: the per-owner uniqueness rule
    // cannot hold both rows for one user, and the workflow identity index cannot
    // hold both as workflow, so the oldest association takes the role.
    const [first] = await db
      .insert(platform_integrations)
      .values(personalIntegration('890007', { created_at: '2026-01-01T00:00:00.000Z' }))
      .returning();
    const [second] = await db
      .insert(platform_integrations)
      .values(
        personalIntegration('890007', {
          created_at: '2026-02-01T00:00:00.000Z',
          owned_by_user_id: otherUserId,
          created_by_user_id: otherUserId,
        })
      )
      .returning();

    await applyConnectionRoleBackfill();

    expect(await readRole(first.id)).toBe('workflow');
    // The second association would collide with the workflow identity index, so
    // it stays out of the listing rather than breaking the migration.
    expect(await readRole(second.id)).toBeNull();
  });
});
