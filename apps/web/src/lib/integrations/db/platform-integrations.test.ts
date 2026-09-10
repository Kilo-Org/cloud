import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db, pool } from '@/lib/drizzle';
import {
  repository_customizations,
  platform_integrations,
  kilocode_users,
  organizations,
  github_app_installations,
} from '@kilocode/db/schema';
import { and, eq } from 'drizzle-orm';
import {
  deleteIntegration,
  deleteGitHubInstallationRecords,
  deleteIntegrationForOwner,
  createPendingIntegration,
  findIntegrationByInstallationId,
  findGitHubBotLinkIntegrations,
  getRepositoryCustomization,
  listRepositoryCustomizations,
  suspendIntegration,
  suspendIntegrationForOwner,
  unsuspendIntegration,
  unsuspendIntegrationForOwner,
  updateIntegrationMetadataForOwner,
  updateIntegrationRepositories,
  upsertRepositoryCustomization,
  upsertPlatformIntegrationForOwner,
} from './platform-integrations';
import type { Owner } from '../core/types';
import { insertTestUser } from '@/tests/helpers/user.helper';

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

  test('rejects a second GitHub installation for an organization outside the allowlist', async () => {
    const owner: Owner = { type: 'org', id: orgId };
    await upsertPlatformIntegrationForOwner(owner, baseInstallData(INSTALLATION_ID));

    const result = await upsertPlatformIntegrationForOwner(
      owner,
      baseInstallData(`${INSTALLATION_ID}-second`)
    );

    expect(result).toEqual({ ok: false, reason: 'multiple_installations_disabled' });

    const rows = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, orgId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.platform_installation_id).toBe(INSTALLATION_ID);
  });

  test('serializes concurrent different installations for a non-allowlisted organization', async () => {
    const owner: Owner = { type: 'org', id: orgId };
    const installationIds = [`${INSTALLATION_ID}-concurrent-a`, `${INSTALLATION_ID}-concurrent-b`];
    const lockClient = await pool.connect();
    const ownerLockKey = `${owner.type}:${owner.id}`;
    let lockAcquired = false;
    let operationError: unknown;
    let pendingOperations:
      | Promise<Awaited<ReturnType<typeof upsertPlatformIntegrationForOwner>>>[]
      | undefined;
    try {
      const identity = await lockClient.query<{ pid: number; database: string }>(
        'SELECT pg_backend_pid() AS pid, current_database() AS database'
      );
      const holderPid = identity.rows[0]?.pid;
      expect(holderPid).toBeDefined();
      await lockClient.query('SELECT pg_advisory_lock(hashtext($1))', [ownerLockKey]);
      lockAcquired = true;
      pendingOperations = installationIds.map(installationId =>
        upsertPlatformIntegrationForOwner(owner, baseInstallData(installationId))
      );
      let waitingCount = 0;
      for (let attempt = 0; attempt < 2000 && waitingCount < 2; attempt += 1) {
        const result = await lockClient.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM pg_stat_activity activity
           WHERE activity.datname = current_database()
             AND $1::int = ANY(pg_blocking_pids(activity.pid))
             AND activity.wait_event_type = 'Lock' AND activity.wait_event = 'advisory'
             AND query LIKE 'SELECT pg_advisory_xact_lock(hashtext(%'`,
          [holderPid]
        );
        waitingCount = Number(result.rows[0]?.count ?? 0);
        if (waitingCount < 2) await new Promise<void>(resolve => setImmediate(resolve));
      }
      expect(waitingCount).toBeGreaterThanOrEqual(2);
    } catch (error) {
      operationError = error;
    } finally {
      let unlockFailed = false;
      try {
        if (lockAcquired) {
          await lockClient.query('SELECT pg_advisory_unlock(hashtext($1))', [ownerLockKey]);
        }
      } catch (error) {
        unlockFailed = true;
        operationError ??= error;
      } finally {
        lockClient.release(unlockFailed);
      }
      if (pendingOperations) await Promise.allSettled(pendingOperations);
    }
    if (operationError) throw operationError;
    if (!pendingOperations) throw new Error('Concurrent upserts did not start');
    const results = await Promise.all(pendingOperations);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results).toContainEqual({ ok: false, reason: 'multiple_installations_disabled' });
    const rows = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.owned_by_organization_id, orgId));
    expect(rows).toHaveLength(1);
    expect(installationIds).toContain(rows[0]?.platform_installation_id);
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

  test('pending GitHub app targets are idempotent per owner without suppressing another owner', async () => {
    const accountId = `pending-target-${Date.now()}`;
    const request = {
      requester: {
        kilo_user_id: userId,
        kilo_user_email: 'requester@example.com',
        kilo_user_name: 'Requester',
        requested_at: new Date().toISOString(),
      },
      githubRequester: { id: 'github-requester', login: 'requester' },
      githubRequest: {
        id: 'github-request',
        accountId,
        accountLogin: 'target-org',
      },
      githubAppType: 'standard' as const,
    };

    const results = await Promise.all([
      createPendingIntegration({ ...request, userId }),
      createPendingIntegration({ ...request, userId: otherUserId }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(2);
    const rows = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.platform_account_id, accountId));
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

    test('deleteGitHubInstallationRecords deletes all effective standard rows for one installation', async () => {
      await db.insert(platform_integrations).values([
        {
          owned_by_user_id: userId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '1000',
          platform_account_login: 'user-standard',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'standard',
        },
        {
          owned_by_user_id: otherUserId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '2000',
          platform_account_login: 'user-legacy-standard',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: null,
        },
        {
          owned_by_organization_id: orgId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '3000',
          platform_account_login: 'org-lite',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'lite',
        },
        {
          owned_by_organization_id: otherOrgId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: siblingInstallId,
          platform_account_id: '4000',
          platform_account_login: 'org-unrelated-standard',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'standard',
        },
      ]);

      await deleteGitHubInstallationRecords(destructiveInstallId, 'standard');

      expect(await getRowsByInstallId()).toEqual([
        expect.objectContaining({
          platform_installation_id: destructiveInstallId,
          github_app_type: 'lite',
        }),
      ]);
      expect(
        await db
          .select()
          .from(platform_integrations)
          .where(eq(platform_integrations.platform_installation_id, siblingInstallId))
      ).toEqual([
        expect.objectContaining({
          github_app_type: 'standard',
          owned_by_organization_id: otherOrgId,
        }),
      ]);
    });

    test('deleteGitHubInstallationRecords deletes only lite rows for a lite webhook', async () => {
      await db.insert(platform_integrations).values([
        {
          owned_by_user_id: userId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '1000',
          platform_account_login: 'user-standard',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'standard',
        },
        {
          owned_by_user_id: otherUserId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '2000',
          platform_account_login: 'user-legacy-standard',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: null,
        },
        {
          owned_by_organization_id: orgId,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: destructiveInstallId,
          platform_account_id: '3000',
          platform_account_login: 'org-lite',
          repository_access: 'all',
          integration_status: 'active',
          github_app_type: 'lite',
        },
      ]);

      await deleteGitHubInstallationRecords(destructiveInstallId, 'lite');

      const rows = await getRowsByInstallId();
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ github_app_type: 'standard' }),
          expect.objectContaining({ github_app_type: null }),
        ])
      );
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

    // Two rows for the same owner, same app type, but different installation
    // ids are legal (the GitHub unique index is keyed per installation id).
    // A mutation scoped only to owner and app type would touch both rows; the
    // installation-scoped one must leave the sibling untouched.
    async function seedOrgSameAppTypeSiblings() {
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
          github_app_type: 'standard',
        },
      ]);
    }

    async function seedUserSameAppTypeSiblings() {
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
          github_app_type: 'standard',
        },
      ]);
    }

    test('deleteIntegration with installation id leaves the same-owner same-app-type sibling', async () => {
      await seedOrgSameAppTypeSiblings();

      await deleteIntegration(orgId, 'github', 'standard', destructiveInstallId);

      const rows = await getOrgRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].platform_installation_id).toBe(siblingInstallId);
      expect(rows[0].github_app_type).toBe('standard');
    });

    test('suspendIntegration with installation id leaves the same-owner same-app-type sibling active', async () => {
      await seedOrgSameAppTypeSiblings();

      await suspendIntegration(orgId, 'github', 'webhook-sender', 'standard', destructiveInstallId);

      const rows = await getOrgRows();
      expect(rows).toHaveLength(2);
      const matched = rows.find(row => row.platform_installation_id === destructiveInstallId);
      const sibling = rows.find(row => row.platform_installation_id === siblingInstallId);
      expect(matched?.integration_status).toBe('suspended');
      expect(matched?.suspended_by).toBe('webhook-sender');
      expect(sibling?.integration_status).toBe('active');
      expect(sibling?.suspended_at).toBeNull();
    });

    test('unsuspendIntegration with installation id leaves the same-owner same-app-type sibling suspended', async () => {
      await seedOrgSameAppTypeSiblings();
      await db
        .update(platform_integrations)
        .set({ integration_status: 'suspended' })
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.owned_by_organization_id, orgId)
          )
        );

      await unsuspendIntegration(orgId, 'github', 'standard', destructiveInstallId);

      const rows = await getOrgRows();
      expect(rows).toHaveLength(2);
      const matched = rows.find(row => row.platform_installation_id === destructiveInstallId);
      const sibling = rows.find(row => row.platform_installation_id === siblingInstallId);
      expect(matched?.integration_status).toBe('active');
      expect(sibling?.integration_status).toBe('suspended');
    });

    test('deleteIntegrationForOwner with installation id leaves the same-owner same-app-type sibling', async () => {
      await seedUserSameAppTypeSiblings();

      await deleteIntegrationForOwner(
        { type: 'user', id: userId },
        'github',
        'standard',
        destructiveInstallId
      );

      const rows = await getUserRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].platform_installation_id).toBe(siblingInstallId);
      expect(rows[0].github_app_type).toBe('standard');
    });

    test('suspendIntegrationForOwner with installation id leaves the same-owner same-app-type sibling active', async () => {
      await seedUserSameAppTypeSiblings();

      await suspendIntegrationForOwner(
        { type: 'user', id: userId },
        'github',
        'webhook-sender',
        'standard',
        destructiveInstallId
      );

      const rows = await getUserRows();
      expect(rows).toHaveLength(2);
      const matched = rows.find(row => row.platform_installation_id === destructiveInstallId);
      const sibling = rows.find(row => row.platform_installation_id === siblingInstallId);
      expect(matched?.integration_status).toBe('suspended');
      expect(sibling?.integration_status).toBe('active');
    });

    test('unsuspendIntegrationForOwner with installation id leaves the same-owner same-app-type sibling suspended', async () => {
      await seedUserSameAppTypeSiblings();
      await db
        .update(platform_integrations)
        .set({ integration_status: 'suspended' })
        .where(
          and(
            eq(platform_integrations.platform, 'github'),
            eq(platform_integrations.owned_by_user_id, userId)
          )
        );

      await unsuspendIntegrationForOwner(
        { type: 'user', id: userId },
        'github',
        'standard',
        destructiveInstallId
      );

      const rows = await getUserRows();
      expect(rows).toHaveLength(2);
      const matched = rows.find(row => row.platform_installation_id === destructiveInstallId);
      const sibling = rows.find(row => row.platform_installation_id === siblingInstallId);
      expect(matched?.integration_status).toBe('active');
      expect(sibling?.integration_status).toBe('suspended');
    });
  });
});

describe('findGitHubBotLinkIntegrations', () => {
  afterEach(cleanupDbForTest);

  test('resolves exact shared associations and rejects ambiguous, wrong, or disconnected choices', async () => {
    const userA = (await insertTestUser()).id;
    const userB = (await insertTestUser()).id;
    const [canonical] = await db
      .insert(github_app_installations)
      .values({
        github_app_type: 'standard',
        installation_id: '881122',
        lifecycle_state: 'active',
        sharing_mode: 'web_cloud_agent',
      })
      .returning();
    const associations = await db
      .insert(platform_integrations)
      .values([
        {
          owned_by_user_id: userA,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: '881122',
          github_app_type: 'standard',
          github_installation_id: canonical.id,
          integration_status: 'active',
        },
        {
          owned_by_user_id: userB,
          platform: 'github',
          integration_type: 'app',
          platform_installation_id: '881122',
          github_app_type: 'standard',
          github_installation_id: canonical.id,
          integration_status: 'active',
        },
      ])
      .returning();

    await expect(
      findGitHubBotLinkIntegrations({
        installationId: '881122',
        appType: 'standard',
        platformIntegrationId: associations[0]!.id,
      })
    ).resolves.toEqual([expect.objectContaining({ id: associations[0]!.id })]);
    await expect(
      findGitHubBotLinkIntegrations({ installationId: '881122', appType: 'standard' })
    ).resolves.toEqual([]);
    await expect(
      findGitHubBotLinkIntegrations({
        installationId: '881122',
        appType: 'standard',
        platformIntegrationId: crypto.randomUUID(),
      })
    ).resolves.toEqual([]);
    await expect(
      findGitHubBotLinkIntegrations({
        installationId: '881122',
        appType: 'lite',
        platformIntegrationId: associations[0]!.id,
      })
    ).resolves.toEqual([]);

    await db
      .update(platform_integrations)
      .set({ github_disconnected_at: new Date().toISOString() })
      .where(eq(platform_integrations.id, associations[0]!.id));
    await expect(
      findGitHubBotLinkIntegrations({
        installationId: '881122',
        appType: 'standard',
        platformIntegrationId: associations[0]!.id,
      })
    ).resolves.toEqual([]);
  });

  test('accepts one true legacy Standard/null association', async () => {
    const userId = (await insertTestUser()).id;
    const [legacy] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: userId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '881123',
        github_app_type: null,
        integration_status: 'active',
      })
      .returning();
    await expect(
      findGitHubBotLinkIntegrations({ installationId: '881123', appType: 'standard' })
    ).resolves.toEqual([expect.objectContaining({ id: legacy.id })]);
  });
});

describe('updateIntegrationMetadataForOwner', () => {
  const orgId = crypto.randomUUID();
  const otherOrgId = crypto.randomUUID();
  const installationId = `test-metadata-merge-${Date.now()}`;
  const otherInstallationId = `test-metadata-merge-other-${Date.now()}`;
  let integrationId: string;
  let otherIntegrationId: string;

  beforeEach(async () => {
    await db.insert(organizations).values([
      { id: orgId, name: `Metadata merge org ${Date.now()}` },
      { id: otherOrgId, name: `Metadata merge other org ${Date.now()}` },
    ]);
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: orgId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: installationId,
        integration_status: 'active',
        repository_access: 'all',
        metadata: { model_slug: 'model-a' },
      })
      .returning();
    integrationId = integration.id;
    const [otherIntegration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: orgId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: otherInstallationId,
        integration_status: 'active',
        repository_access: 'all',
        metadata: { model_slug: 'model-c' },
      })
      .returning();
    otherIntegrationId = otherIntegration.id;
  });

  afterEach(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
    await db.delete(organizations).where(eq(organizations.id, otherOrgId));
  });

  test('merges without deleting unrelated keys and without a read-then-write race', async () => {
    // Two concurrent writers touching different keys must both survive: a
    // read-modify-write implementation would let one overwrite the other.
    await Promise.all([
      updateIntegrationMetadataForOwner(
        { type: 'org', id: orgId },
        'github',
        { model_slug: 'model-b' },
        integrationId
      ),
      updateIntegrationMetadataForOwner(
        { type: 'org', id: orgId },
        'github',
        { pr_review_mode: 'off' },
        integrationId
      ),
    ]);

    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integrationId));

    expect(row?.metadata).toMatchObject({ model_slug: 'model-b', pr_review_mode: 'off' });
  });

  test('scopes the update to integrationId, leaving a sibling integration untouched', async () => {
    await updateIntegrationMetadataForOwner(
      { type: 'org', id: orgId },
      'github',
      { model_slug: 'model-b' },
      integrationId
    );

    const [updated] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, integrationId));
    const [untouched] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, otherIntegrationId));

    expect(updated?.metadata).toMatchObject({ model_slug: 'model-b' });
    expect(untouched?.metadata).toMatchObject({ model_slug: 'model-c' });
  });

  test('throws when owner or platform does not match any integration', async () => {
    await expect(
      updateIntegrationMetadataForOwner(
        { type: 'org', id: otherOrgId },
        'github',
        { model_slug: 'model-b' },
        integrationId
      )
    ).rejects.toThrow('No github integration found for owner');
  });
});

describe('repository_customizations accessors', () => {
  const orgId = crypto.randomUUID();
  const installationId = `test-repo-custom-${Date.now()}`;
  let integrationId: string;

  beforeEach(async () => {
    await db.insert(organizations).values({ id: orgId, name: `Repo custom org ${Date.now()}` });
    const [integration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: orgId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: installationId,
        integration_status: 'active',
        repository_access: 'all',
      })
      .returning();
    integrationId = integration.id;
  });

  afterEach(async () => {
    await db.delete(organizations).where(eq(organizations.id, orgId));
  });

  test('upsertRepositoryCustomization inserts, then updates only the supplied fields', async () => {
    await upsertRepositoryCustomization(integrationId, '1', {
      bot_mention_model_slug: 'model-a',
      pr_review_mode: 'on',
    });

    await upsertRepositoryCustomization(integrationId, '1', {
      pr_review_mode: 'off',
    });

    const [row] = await listRepositoryCustomizations(integrationId);

    expect(row).toMatchObject({
      repository_id: '1',
      bot_mention_model_slug: 'model-a',
      pr_review_mode: 'off',
    });
  });

  test('upsertRepositoryCustomization clears a field back to inherited with null', async () => {
    await upsertRepositoryCustomization(integrationId, '1', {
      bot_mention_model_slug: 'model-a',
      pr_review_mode: 'on',
    });

    await upsertRepositoryCustomization(integrationId, '1', {
      bot_mention_model_slug: null,
    });

    const [row] = await listRepositoryCustomizations(integrationId);

    expect(row).toMatchObject({ bot_mention_model_slug: null, pr_review_mode: 'on' });
  });

  test('listRepositoryCustomizations only returns rows for the given integration', async () => {
    const [otherIntegration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: orgId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: `${installationId}-other`,
        integration_status: 'active',
        repository_access: 'all',
      })
      .returning();

    await upsertRepositoryCustomization(integrationId, '1', { pr_review_mode: 'on' });
    await upsertRepositoryCustomization(otherIntegration.id, '1', { pr_review_mode: 'off' });

    const rows = await listRepositoryCustomizations(integrationId);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ platform_integration_id: integrationId, pr_review_mode: 'on' });
  });

  test('deleting the parent integration cascades to its customizations', async () => {
    await upsertRepositoryCustomization(integrationId, '1', { pr_review_mode: 'on' });

    await db.delete(platform_integrations).where(eq(platform_integrations.id, integrationId));

    const remaining = await db
      .select()
      .from(repository_customizations)
      .where(eq(repository_customizations.platform_integration_id, integrationId));

    expect(remaining).toHaveLength(0);
  });

  test('getRepositoryCustomization returns null when the repository has no override', async () => {
    const customization = await getRepositoryCustomization(integrationId, '1');

    expect(customization).toBeNull();
  });

  test('getRepositoryCustomization returns the matching row', async () => {
    await upsertRepositoryCustomization(integrationId, '1', {
      bot_mention_model_slug: 'model-a',
      pr_review_mode: 'on',
    });

    const customization = await getRepositoryCustomization(integrationId, '1');

    expect(customization).toMatchObject({
      platform_integration_id: integrationId,
      repository_id: '1',
      bot_mention_model_slug: 'model-a',
      pr_review_mode: 'on',
    });
  });

  test("getRepositoryCustomization does not leak another integration's row for the same repository_id", async () => {
    const [otherIntegration] = await db
      .insert(platform_integrations)
      .values({
        owned_by_organization_id: orgId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: `${installationId}-other-lookup`,
        integration_status: 'active',
        repository_access: 'all',
      })
      .returning();

    await upsertRepositoryCustomization(otherIntegration.id, '1', {
      bot_mention_model_slug: 'other-integration-model',
    });

    const customization = await getRepositoryCustomization(integrationId, '1');

    expect(customization).toBeNull();
  });
});
