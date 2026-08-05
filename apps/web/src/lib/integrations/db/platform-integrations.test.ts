import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { platform_integrations, kilocode_users, organizations } from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  deleteIntegration,
  deleteIntegrationForOwner,
  findIntegrationByInstallationId,
  suspendIntegration,
  suspendIntegrationForOwner,
  unsuspendIntegration,
  unsuspendIntegrationForOwner,
  updateIntegrationRepositories,
  upsertPlatformIntegrationForOwner,
} from './platform-integrations';
import type { Owner } from '../core/types';

const INSTALLATION_ID = `test-github-install-${Date.now()}`;

describe('upsertPlatformIntegrationForOwner', () => {
  const userId = `test-upsert-user-${Date.now()}`;
  const otherUserId = `test-upsert-other-user-${Date.now()}`;
  const orgId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();

  beforeEach(async () => {
    await db.insert(kilocode_users).values([
      {
        id: userId,
        google_user_email: `upsert-${Date.now()}-a@example.com`,
        google_user_name: 'Upsert Test User A',
        google_user_image_url: 'https://example.com/avatar.jpg',
        stripe_customer_id: `cus_upsert_a_${Date.now()}`,
      },
      {
        id: otherUserId,
        google_user_email: `upsert-${Date.now()}-b@example.com`,
        google_user_name: 'Upsert Test User B',
        google_user_image_url: 'https://example.com/avatar.jpg',
        stripe_customer_id: `cus_upsert_b_${Date.now()}`,
      },
    ]);

    await db.insert(organizations).values([
      { id: orgId, name: `Upsert Test Org A ${Date.now()}` },
      { id: otherOrgId, name: `Upsert Test Org B ${Date.now()}` },
    ]);
  });

  afterEach(async () => {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, userId));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_user_id, otherUserId));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, orgId));
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, otherOrgId));
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, otherOrgId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
    await db.delete(kilocode_users).where(eq(kilocode_users.id, otherUserId));
  });

  const baseInstallData = (installationId: string) => ({
    platform: 'github',
    integrationType: 'app',
    platformInstallationId: installationId,
    platformAccountId: '12345',
    platformAccountLogin: 'test-owner',
    permissions: null,
    scopes: [],
    repositoryAccess: 'all' as const,
    repositories: null,
    installedAt: new Date().toISOString(),
    githubAppType: 'standard' as const,
  });

  test('inserts a new GitHub installation for a user owner', async () => {
    const owner: Owner = { type: 'user', id: userId };
    const result = await upsertPlatformIntegrationForOwner(owner, baseInstallData(INSTALLATION_ID));

    expect(result).toEqual({ ok: true });

    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));

    expect(row).toBeDefined();
    expect(row.owned_by_user_id).toBe(userId);
    expect(row.owned_by_organization_id).toBeNull();
    expect(row.platform).toBe('github');
  });

  test('inserts a new GitHub installation for an org owner', async () => {
    const owner: Owner = { type: 'org', id: orgId };
    const result = await upsertPlatformIntegrationForOwner(owner, baseInstallData(INSTALLATION_ID));

    expect(result).toEqual({ ok: true });

    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));

    expect(row.owned_by_user_id).toBeNull();
    expect(row.owned_by_organization_id).toBe(orgId);
  });

  test('same-owner refresh updates the existing row (by primary key)', async () => {
    const owner: Owner = { type: 'user', id: userId };

    // First insert.
    await upsertPlatformIntegrationForOwner(owner, baseInstallData(INSTALLATION_ID));

    // Second call with different account login — same-owner refresh.
    const result = await upsertPlatformIntegrationForOwner(owner, {
      ...baseInstallData(INSTALLATION_ID),
      platformAccountLogin: 'new-login',
    });

    expect(result).toEqual({ ok: true });

    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));

    expect(row.platform_account_login).toBe('new-login');
    // Ownership must not have changed.
    expect(row.owned_by_user_id).toBe(userId);
    expect(row.owned_by_organization_id).toBeNull();
  });

  test('cross-owner collision returns claimed_by_other_owner without updating', async () => {
    const ownerA: Owner = { type: 'user', id: userId };
    const ownerB: Owner = { type: 'user', id: otherUserId };

    // Owner A claims the installation.
    await upsertPlatformIntegrationForOwner(ownerA, baseInstallData(INSTALLATION_ID));

    // Owner B tries to claim the same installation.
    const result = await upsertPlatformIntegrationForOwner(
      ownerB,
      baseInstallData(INSTALLATION_ID)
    );

    expect(result).toEqual({ ok: false, reason: 'claimed_by_other_owner' });

    // Ownership must still be owner A.
    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));

    expect(row.owned_by_user_id).toBe(userId);
  });

  test('cross-owner type mismatch returns claimed_by_other_owner (user vs org)', async () => {
    // Insert as a user owner.
    const userOwner: Owner = { type: 'user', id: userId };
    await upsertPlatformIntegrationForOwner(userOwner, baseInstallData(INSTALLATION_ID));

    // Try to upsert as an org owner. The owner type differs from the existing
    // integration's user ownership, so the comparison must reject it.
    const orgOwner: Owner = { type: 'org', id: orgId };
    const result = await upsertPlatformIntegrationForOwner(
      orgOwner,
      baseInstallData(INSTALLATION_ID)
    );

    expect(result).toEqual({ ok: false, reason: 'claimed_by_other_owner' });

    // Ownership must still be the user owner.
    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));

    expect(row.owned_by_user_id).toBe(userId);
    expect(row.owned_by_organization_id).toBeNull();
  });

  test('second insert after unique index hit same-owner refresh updates (edge case)', async () => {
    const owner: Owner = { type: 'user', id: userId };

    // Insert a row with onConflictDoNothing on global index.
    const result1 = await upsertPlatformIntegrationForOwner(
      owner,
      baseInstallData(INSTALLATION_ID)
    );
    expect(result1).toEqual({ ok: true });

    // Same owner inserts again, skips onDoNothing, re-reads, finds same owner.
    const result2 = await upsertPlatformIntegrationForOwner(owner, {
      ...baseInstallData(INSTALLATION_ID),
      platformAccountLogin: 'refreshed-login',
    });
    expect(result2).toEqual({ ok: true });

    // Verify the update happened.
    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, INSTALLATION_ID));

    expect(row.platform_account_login).toBe('refreshed-login');
  });

  const crossTypeInstallId = `test-github-cross-type-${Date.now()}`;

  afterEach(async () => {
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.platform_installation_id, crossTypeInstallId));
  });

  test('selects the correct row for the same installation id across app types', async () => {
    const ownerA: Owner = { type: 'user', id: userId };
    const ownerB: Owner = { type: 'user', id: otherUserId };

    await upsertPlatformIntegrationForOwner(ownerA, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'standard',
    });
    await upsertPlatformIntegrationForOwner(ownerB, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'lite',
    });

    const standard = await findIntegrationByInstallationId(
      'github',
      crossTypeInstallId,
      'standard'
    );
    const lite = await findIntegrationByInstallationId('github', crossTypeInstallId, 'lite');

    expect(standard?.owned_by_user_id).toBe(userId);
    expect(standard?.github_app_type).toBe('standard');
    expect(lite?.owned_by_user_id).toBe(otherUserId);
    expect(lite?.github_app_type).toBe('lite');
  });

  test('cross-owner conflict is scoped to the app type', async () => {
    const ownerA: Owner = { type: 'user', id: userId };
    const ownerB: Owner = { type: 'user', id: otherUserId };

    // Owner A claims the installation with the standard app.
    await upsertPlatformIntegrationForOwner(ownerA, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'standard',
    });

    // Owner B cannot claim the same standard row.
    const blocked = await upsertPlatformIntegrationForOwner(ownerB, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'standard',
    });
    expect(blocked).toEqual({ ok: false, reason: 'claimed_by_other_owner' });

    // Owner B can claim the same installation id under the lite app.
    const liteClaim = await upsertPlatformIntegrationForOwner(ownerB, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'lite',
    });
    expect(liteClaim).toEqual({ ok: true });

    const rows = await db
      .select()
      .from(platform_integrations)
      .where(
        and(
          eq(platform_integrations.platform, 'github'),
          eq(platform_integrations.platform_installation_id, crossTypeInstallId)
        )
      );
    expect(rows).toHaveLength(2);
  });

  test('same-owner refresh with app type is not confused by another owner other-app-type row', async () => {
    const ownerA: Owner = { type: 'user', id: userId };
    const ownerB: Owner = { type: 'user', id: otherUserId };

    // Owner B claims the lite row first so an unscoped lookup would find it.
    await upsertPlatformIntegrationForOwner(ownerB, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'lite',
    });

    // Owner A claims the standard row.
    const claimed = await upsertPlatformIntegrationForOwner(ownerA, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'standard',
    });
    expect(claimed).toEqual({ ok: true });

    // Owner A refreshes the standard row — must not hit owner B's lite row.
    const refreshed = await upsertPlatformIntegrationForOwner(ownerA, {
      ...baseInstallData(crossTypeInstallId),
      githubAppType: 'standard',
      platformAccountLogin: 'refreshed-login',
    });
    expect(refreshed).toEqual({ ok: true });

    const standard = await findIntegrationByInstallationId(
      'github',
      crossTypeInstallId,
      'standard'
    );
    const lite = await findIntegrationByInstallationId('github', crossTypeInstallId, 'lite');

    expect(standard?.owned_by_user_id).toBe(userId);
    expect(standard?.platform_account_login).toBe('refreshed-login');
    expect(standard?.github_app_type).toBe('standard');
    expect(lite?.owned_by_user_id).toBe(otherUserId);
    expect(lite?.github_app_type).toBe('lite');
  });

  describe('app-type-scoped destructive mutations', () => {
    const destructiveInstallId = `test-github-destructive-${Date.now()}`;
    const siblingInstallId = `test-github-destructive-sibling-${Date.now()}`;

    async function getRowsByInstallId() {
      return db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.platform_installation_id, destructiveInstallId)
          )
        );
    }

    async function getOrgRows() {
      return db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.owned_by_organization_id, orgId)
          )
        );
    }

    async function getUserRows() {
      return db
        .select()
        .from(platform_integrations)
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.owned_by_user_id, userId)
          )
        );
    }

    // The owner unique index `(owner, platform, installation_id)` forbids two
    // rows for the same owner and installation id, so an owner's standard and
    // lite rows live on separate installations. An unscoped owner mutation
    // (app-type predicate removed) would touch both rows; the app-type scoped
    // one must leave the lite sibling untouched.
    async function seedOrgSiblings() {
      await db.insert(platform_integrations).values([
        {
          owned_by_organization_id: orgId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '1000',
          platform_account_login: 'org-a',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'standard',
        },
        {
          owned_by_organization_id: orgId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: siblingInstallId,
          platform_account_id: '2000',
          platform_account_login: 'org-b',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'lite',
        },
      ]);
    }

    async function seedUserSiblings() {
      await db.insert(platform_integrations).values([
        {
          owned_by_user_id: userId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '3000',
          platform_account_login: 'user-a',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'standard',
        },
        {
          owned_by_user_id: userId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: siblingInstallId,
          platform_account_id: '4000',
          platform_account_login: 'user-b',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'lite',
        },
      ]);
    }

    // The installation-scoped update matches by installation id, so its
    // app-type predicate only matters when two rows share one installation id.
    // That arrangement is legal only across owners (one row per app type).
    async function seedOrgInstallationSiblings() {
      await db.insert(platform_integrations).values([
        {
          owned_by_organization_id: orgId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '1000',
          platform_account_login: 'org-a',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'standard',
        },
        {
          owned_by_organization_id: otherOrgId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '2000',
          platform_account_login: 'org-b',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'lite',
        },
      ]);
    }

    test('deleteIntegration with app type leaves the owner sibling app-type row', async () => {
      await seedOrgSiblings();

      await deleteIntegration(orgId, 'github', 'standard');

      const rows = await getOrgRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].platform_installation_id).toBe(siblingInstallId);
      expect(rows[0].github_app_type).toBe('lite');
    });

    test('suspendIntegration with app type leaves the owner sibling app-type row active', async () => {
      await seedOrgSiblings();

      await suspendIntegration(orgId, 'github', 'webhook-sender', 'standard');

      const rows = await getOrgRows();
      expect(rows).toHaveLength(2);
      const standard = rows.find(row => row.github_app_type === 'standard');
      const lite = rows.find(row => row.github_app_type === 'lite');
      expect(standard?.integration_status).toBe('suspended');
      expect(standard?.suspended_by).toBe('webhook-sender');
      expect(lite?.integration_status).toBe('active');
      expect(lite?.suspended_at).toBeNull();
    });

    test('unsuspendIntegration with app type leaves the owner sibling app-type row suspended', async () => {
      await seedOrgSiblings();
      await db
        .update(platform_integrations)
        .set({ integration_status: 'suspended' })
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.owned_by_organization_id, orgId)
          )
        );

      await unsuspendIntegration(orgId, 'github', 'standard');

      const rows = await getOrgRows();
      expect(rows).toHaveLength(2);
      const standard = rows.find(row => row.github_app_type === 'standard');
      const lite = rows.find(row => row.github_app_type === 'lite');
      expect(standard?.integration_status).toBe('active');
      expect(lite?.integration_status).toBe('suspended');
    });

    test('deleteIntegrationForOwner with app type leaves the owner sibling app-type row', async () => {
      await seedUserSiblings();

      await deleteIntegrationForOwner({ type: 'user', id: userId }, 'github', 'standard');

      const rows = await getUserRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].platform_installation_id).toBe(siblingInstallId);
      expect(rows[0].github_app_type).toBe('lite');
    });

    test('suspendIntegrationForOwner with app type leaves the owner sibling app-type row active', async () => {
      await seedUserSiblings();

      await suspendIntegrationForOwner(
        { type: 'user', id: userId },
        'github',
        'webhook-sender',
        'standard'
      );

      const rows = await getUserRows();
      expect(rows).toHaveLength(2);
      const standard = rows.find(row => row.github_app_type === 'standard');
      const lite = rows.find(row => row.github_app_type === 'lite');
      expect(standard?.integration_status).toBe('suspended');
      expect(lite?.integration_status).toBe('active');
    });

    test('unsuspendIntegrationForOwner with app type leaves the owner sibling app-type row suspended', async () => {
      await seedUserSiblings();
      await db
        .update(platform_integrations)
        .set({ integration_status: 'suspended' })
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.owned_by_user_id, userId)
          )
        );

      await unsuspendIntegrationForOwner({ type: 'user', id: userId }, 'github', 'standard');

      const rows = await getUserRows();
      expect(rows).toHaveLength(2);
      const standard = rows.find(row => row.github_app_type === 'standard');
      const lite = rows.find(row => row.github_app_type === 'lite');
      expect(standard?.integration_status).toBe('active');
      expect(lite?.integration_status).toBe('suspended');
    });

    test('updateIntegrationRepositories with app type updates only the matched row', async () => {
      await seedOrgInstallationSiblings();

      await updateIntegrationRepositories(
        'github',
        destructiveInstallId,
        [{ id: 999, name: 'new-repo', full_name: 'acme/new-repo', private: false }],
        'standard'
      );

      const rows = await getRowsByInstallId();
      expect(rows).toHaveLength(2);
      const standard = rows.find(row => row.github_app_type === 'standard');
      const lite = rows.find(row => row.github_app_type === 'lite');
      expect(standard?.repositories).toEqual([
        { id: 999, name: 'new-repo', full_name: 'acme/new-repo', private: false },
      ]);
      expect(lite?.repositories).toBeNull();
    });
  });
});
