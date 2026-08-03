import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { db } from '@/lib/drizzle';
import { platform_integrations, kilocode_users, organizations } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { upsertPlatformIntegrationForOwner } from './platform-integrations';
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
});
