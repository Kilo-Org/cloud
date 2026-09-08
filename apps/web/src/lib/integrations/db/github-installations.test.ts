import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { cleanupDbForTest, db } from '@/lib/drizzle';
import {
  github_app_installations,
  github_connection_attempts,
  kilocode_users,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  connectVerifiedGitHubInstallation,
  disconnectGitHubInstallation,
  observeGitHubInstallationLifecycle,
  updateGitHubInstallationRepositories,
  updateGitHubInstallationAccountIdentity,
} from './github-installations';
import { backfillGitHubInstallations } from './github-installations-backfill';
import { assertGitHubInstallationRuntimeAuthorized } from '../github/runtime-authorization';
import { updateRepositoriesForIntegration } from './platform-integrations';

const ownerId = 'oauth/github-installation-owner';
const otherOwnerId = 'oauth/github-installation-other-owner';

const data = (installationId = '123456') => ({
  platformInstallationId: installationId,
  platformAccountId: '98765',
  platformAccountLogin: 'acme',
  permissions: { contents: 'read' },
  scopes: ['push'],
  repositoryAccess: 'all',
  repositories: [{ id: 1, name: 'repo', full_name: 'acme/repo', private: true }],
  installedAt: '2026-09-04T00:00:00.000Z',
  githubAppType: 'standard' as const,
  kiloUserId: ownerId,
  githubUserId: '1234',
  accountType: 'Organization' as const,
});

describe('GitHub installation persistence', () => {
  beforeEach(async () => {
    await cleanupDbForTest();
    await db.insert(kilocode_users).values([
      {
        id: ownerId,
        google_user_email: 'owner@example.com',
        google_user_name: 'Owner',
        google_user_image_url: '',
        stripe_customer_id: 'cus_owner',
      },
      {
        id: otherOwnerId,
        google_user_email: 'other@example.com',
        google_user_name: 'Other',
        google_user_image_url: '',
        stripe_customer_id: 'cus_other',
      },
    ]);
  });

  afterEach(cleanupDbForTest);

  test('reconnects the same association after local disconnect and rejects another owner', async () => {
    const first = await connectVerifiedGitHubInstallation({ type: 'user', id: ownerId }, data());
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) throw new Error('Expected initial connection');
    await disconnectGitHubInstallation({ type: 'user', id: ownerId }, first.integrationId);
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'user', id: otherOwnerId },
        { ...data(), kiloUserId: otherOwnerId }
      )
    ).resolves.toEqual({ ok: false, reason: 'claimed_by_other_owner' });
    await expect(
      connectVerifiedGitHubInstallation({ type: 'user', id: ownerId }, data())
    ).resolves.toEqual({ ok: true, integrationId: first.integrationId });
  });

  test('revokes the real runtime authorization query on local disconnect', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data()
    );
    if (!connected.ok) throw new Error('Expected initial connection');
    await expect(
      assertGitHubInstallationRuntimeAuthorized('123456', 'standard')
    ).resolves.toBeUndefined();
    await disconnectGitHubInstallation({ type: 'user', id: ownerId }, connected.integrationId);
    await expect(assertGitHubInstallationRuntimeAuthorized('123456', 'standard')).rejects.toThrow(
      'GitHub installation is unavailable for runtime use'
    );
  });

  test('rejects the real runtime authorization query for a blocked personal owner', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data()
    );
    if (!connected.ok) throw new Error('Expected initial connection');
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'test block' })
      .where(eq(kilocode_users.id, ownerId));
    await expect(assertGitHubInstallationRuntimeAuthorized('123456', 'standard')).rejects.toThrow(
      'GitHub installation is unavailable for runtime use'
    );
  });

  test('keeps canonical repositories aligned with user refresh and suppresses disconnected projection', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data()
    );
    if (!connected.ok) throw new Error('Expected initial connection');
    const refreshed = [{ id: 2, name: 'fresh', full_name: 'acme/fresh', private: false }];
    await updateRepositoriesForIntegration(connected.integrationId, refreshed);
    const [association] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    const [canonical] = await db
      .select()
      .from(github_app_installations)
      .where(eq(github_app_installations.id, association?.github_installation_id ?? ''));
    expect(association?.repositories).toEqual(refreshed);
    expect(canonical?.repositories).toEqual(refreshed);

    await disconnectGitHubInstallation({ type: 'user', id: ownerId }, connected.integrationId);
    await updateGitHubInstallationRepositories({
      installationId: '123456',
      appType: 'standard',
      repositoriesAdded: [{ id: 3, name: 'late', full_name: 'acme/late', private: false }],
    });
    const [disconnected] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    const [updatedCanonical] = await db
      .select()
      .from(github_app_installations)
      .where(eq(github_app_installations.id, association?.github_installation_id ?? ''));
    expect(disconnected?.repositories).toEqual(refreshed);
    expect(updatedCanonical?.repositories).toContainEqual(
      expect.objectContaining({ id: 3, full_name: 'acme/late' })
    );
  });

  test('clears a retained attempt reference when its integration is deleted', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data()
    );
    if (!connected.ok) throw new Error('Expected initial connection');
    const [attempt] = await db
      .insert(github_connection_attempts)
      .values({
        kilo_user_id: ownerId,
        owner_type: 'user',
        owner_id: ownerId,
        github_app_type: 'standard',
        completed_integration_id: connected.integrationId,
        expires_at: '2026-09-08T00:00:00.000Z',
      })
      .returning();
    await db
      .delete(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    const [retained] = await db
      .select()
      .from(github_connection_attempts)
      .where(eq(github_connection_attempts.id, attempt.id));
    expect(retained?.completed_integration_id).toBeNull();
  });

  test('keeps a late rename out of a disconnected projection while updating canonical identity', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data()
    );
    if (!connected.ok) throw new Error('Expected initial connection');
    await disconnectGitHubInstallation({ type: 'user', id: ownerId }, connected.integrationId);
    await updateGitHubInstallationAccountIdentity({
      integrationId: connected.integrationId,
      accountId: '222',
      accountLogin: 'renamed-acme',
    });
    const [association] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, connected.integrationId));
    const [canonical] = await db
      .select()
      .from(github_app_installations)
      .where(eq(github_app_installations.id, association?.github_installation_id ?? ''));
    expect(association?.platform_account_login).toBe('acme');
    expect(canonical).toMatchObject({ account_id: '222', account_login: 'renamed-acme' });
  });

  test('rejects malformed upstream installation ids', async () => {
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'user', id: ownerId },
        data('not-an-installation-id')
      )
    ).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
  });

  test('does not revive a locally disconnected association after an upstream unsuspend', async () => {
    const connected = await connectVerifiedGitHubInstallation(
      { type: 'user', id: ownerId },
      data()
    );
    if (!connected.ok) throw new Error('Expected initial connection');
    await disconnectGitHubInstallation({ type: 'user', id: ownerId }, connected.integrationId);
    await observeGitHubInstallationLifecycle({
      installationId: '123456',
      appType: 'standard',
      state: 'suspended',
    });
    await observeGitHubInstallationLifecycle({
      installationId: '123456',
      appType: 'standard',
      state: 'active',
    });
    await expect(
      db.query.platform_integrations.findFirst({
        where: eq(platform_integrations.id, connected.integrationId),
      })
    ).resolves.toMatchObject({
      github_disconnected_at: expect.any(String),
      integration_status: 'suspended',
    });
  });

  test('backfills one safe legacy association as a shadow observation', async () => {
    const [legacy] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: ownerId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: '5555',
        platform_account_id: '22',
        platform_account_login: 'acme',
        integration_status: 'active',
        github_app_type: null,
      })
      .returning();
    const result = await backfillGitHubInstallations();
    expect(result).toMatchObject({ scanned: 1, canonicalCreated: 1, linked: 1, skipped: 0 });
    expect(result).toMatchObject({ scanComplete: true, nextCursor: null });
    await expect(
      db.query.platform_integrations.findFirst({ where: eq(platform_integrations.id, legacy.id) })
    ).resolves.toMatchObject({ github_installation_id: expect.any(String) });
    await expect(db.select().from(github_app_installations)).resolves.toEqual([
      expect.objectContaining({ installation_id: '5555', lifecycle_state: 'unknown' }),
    ]);
  });

  test('leaves disabled migration-0205 losers unbound', async () => {
    const [loser] = await db
      .insert(platform_integrations)
      .values({
        owned_by_user_id: ownerId,
        platform: 'github',
        integration_type: 'app',
        platform_installation_id: null,
        integration_status: 'suspended',
        metadata: { github_dedup: { original_installation_id: '6666' } },
      })
      .returning();
    await expect(backfillGitHubInstallations()).resolves.toEqual({
      scanned: 1,
      canonicalCreated: 0,
      linked: 0,
      skipped: 1,
      skippedInvalid: 0,
      skippedDeduplicated: 1,
      skippedAmbiguous: 0,
      scanComplete: true,
      nextCursor: null,
    });
    await expect(
      db.query.platform_integrations.findFirst({ where: eq(platform_integrations.id, loser.id) })
    ).resolves.toMatchObject({ github_installation_id: null, integration_status: 'suspended' });
  });
});
