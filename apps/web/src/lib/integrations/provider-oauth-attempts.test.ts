import { cleanupDbForTest, db } from '@/lib/drizzle';
import { provider_oauth_attempts } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import { beginProviderOAuthAttempt, consumeProviderOAuthAttempt } from './provider-oauth-attempts';
import { connectVerifiedGitHubInstallation } from './db/github-installations';

describe('provider OAuth attempts', () => {
  afterEach(cleanupDbForTest);

  it('is single-use and bound to actor, owner, provider, and expiry', async () => {
    const actor = await insertTestUser();
    const other = await insertTestUser();
    const owner = { type: 'user' as const, id: actor.id };
    await beginProviderOAuthAttempt({
      actorUserId: actor.id,
      owner,
      provider: 'slack',
      state: 'state-1',
    });
    await expect(
      consumeProviderOAuthAttempt({
        actorUserId: other.id,
        owner,
        provider: 'slack',
        state: 'state-1',
      })
    ).resolves.toBe(false);
    await expect(
      consumeProviderOAuthAttempt({
        actorUserId: actor.id,
        owner: { type: 'user', id: other.id },
        provider: 'slack',
        state: 'state-1',
      })
    ).resolves.toBe(false);
    await expect(
      consumeProviderOAuthAttempt({
        actorUserId: actor.id,
        owner,
        provider: 'linear',
        state: 'state-1',
      })
    ).resolves.toBe(false);
    await expect(
      consumeProviderOAuthAttempt({
        actorUserId: actor.id,
        owner,
        provider: 'slack',
        state: 'state-1',
      })
    ).resolves.toBe(true);
    await expect(
      consumeProviderOAuthAttempt({
        actorUserId: actor.id,
        owner,
        provider: 'slack',
        state: 'state-1',
      })
    ).resolves.toBe(false);

    await db
      .update(provider_oauth_attempts)
      .set({ status: 'expired' })
      .where(eq(provider_oauth_attempts.owned_by_user_id, actor.id));
    await beginProviderOAuthAttempt({
      actorUserId: actor.id,
      owner,
      provider: 'slack',
      state: 'state-2',
    });
    await db
      .update(provider_oauth_attempts)
      .set({ expires_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(provider_oauth_attempts.status, 'pending'));
    await expect(
      consumeProviderOAuthAttempt({
        actorUserId: actor.id,
        owner,
        provider: 'slack',
        state: 'state-2',
      })
    ).resolves.toBe(false);
  });

  it('serializes provider start before shared GitHub attach', async () => {
    const incumbent = await insertTestUser();
    const destinationUser = await insertTestUser();
    const organizationA = await createTestOrganization('Reservation A', incumbent.id, 0);
    const organizationB = await createTestOrganization('Reservation B', destinationUser.id, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationB.id;
    const github = {
      platformInstallationId: '880001',
      githubAppType: 'standard' as const,
      platformAccountId: '99',
      platformAccountLogin: 'acme',
      githubUserId: '99',
      accountType: 'Organization' as const,
      scopes: [],
      installedAt: new Date().toISOString(),
      repositoryAccess: 'all',
      repositories: [],
      permissions: {},
      kiloUserId: incumbent.id,
    };
    await expect(
      connectVerifiedGitHubInstallation({ type: 'org', id: organizationA.id }, github)
    ).resolves.toMatchObject({ ok: true });
    await beginProviderOAuthAttempt({
      actorUserId: destinationUser.id,
      owner: { type: 'org', id: organizationB.id },
      provider: 'slack',
      state: 'state-started',
    });
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationB.id },
        { ...github, kiloUserId: destinationUser.id }
      )
    ).resolves.toEqual({ ok: false, reason: 'incompatible_workflow' });
  });

  it('blocks provider start after shared GitHub attach', async () => {
    const incumbent = await insertTestUser();
    const destinationUser = await insertTestUser();
    const organizationA = await createTestOrganization('Shared start A', incumbent.id, 0);
    const organizationB = await createTestOrganization('Shared start B', destinationUser.id, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = organizationB.id;
    const github = {
      platformInstallationId: '880002',
      githubAppType: 'standard' as const,
      platformAccountId: '100',
      platformAccountLogin: 'acme',
      githubUserId: '100',
      accountType: 'Organization' as const,
      scopes: [],
      installedAt: new Date().toISOString(),
      repositoryAccess: 'all',
      repositories: [],
      permissions: {},
      kiloUserId: incumbent.id,
    };
    await connectVerifiedGitHubInstallation({ type: 'org', id: organizationA.id }, github);
    await connectVerifiedGitHubInstallation(
      { type: 'org', id: organizationB.id },
      { ...github, kiloUserId: destinationUser.id }
    );
    await expect(
      beginProviderOAuthAttempt({
        actorUserId: destinationUser.id,
        owner: { type: 'org', id: organizationB.id },
        provider: 'linear',
        state: 'state-blocked',
      })
    ).rejects.toThrow('not available for shared GitHub installations');
  });
});
