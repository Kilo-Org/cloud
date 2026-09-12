import { cleanupDbForTest, db } from '@/lib/drizzle';
import { organizations, platform_integrations, provider_oauth_attempts } from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';
import { insertTestUser } from '@/tests/helpers/user.helper';
import { createTestOrganization } from '@/tests/helpers/organization.helper';
import {
  beginProviderOAuthAttempt,
  cancelProviderOAuthAttempt,
  consumeProviderOAuthAttempt,
} from './provider-oauth-attempts';
import { connectVerifiedGitHubInstallation } from './db/github-installations';
import { anonymizeCloudUserData } from '@/lib/user';
import { markOrganizationAsDeleted } from '@/lib/organizations/organizations';

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
    await db.insert(platform_integrations).values({
      owned_by_organization_id: organizationB.id,
      platform: 'slack',
      integration_type: 'oauth',
      platform_installation_id: 'T_EXISTING',
      platform_account_id: 'T_EXISTING',
      integration_status: 'active',
      installed_at: new Date().toISOString(),
    });
    await beginProviderOAuthAttempt({
      actorUserId: destinationUser.id,
      owner: { type: 'org', id: organizationB.id },
      provider: 'slack',
      state: 'state-started',
      purpose: 'provider_install',
    });
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationB.id },
        { ...github, kiloUserId: destinationUser.id }
      )
    ).resolves.toEqual({ ok: false, reason: 'incompatible_workflow' });
    await cancelProviderOAuthAttempt({
      actorUserId: destinationUser.id,
      owner: { type: 'org', id: organizationB.id },
      provider: 'slack',
      state: 'state-started',
      purpose: 'provider_install',
    });
    for (const platform of ['linear', 'discord']) {
      await db.insert(platform_integrations).values({
        owned_by_organization_id: organizationB.id,
        platform,
        integration_type: 'oauth',
        platform_installation_id: `${platform}-existing`,
        platform_account_id: `${platform}-existing`,
        integration_status: 'active',
        installed_at: new Date().toISOString(),
      });
      await expect(
        connectVerifiedGitHubInstallation(
          { type: 'org', id: organizationB.id },
          { ...github, kiloUserId: destinationUser.id }
        )
      ).resolves.toEqual({ ok: false, reason: 'incompatible_workflow' });
      await db.delete(platform_integrations).where(eq(platform_integrations.platform, platform));
    }
    await expect(
      connectVerifiedGitHubInstallation(
        { type: 'org', id: organizationB.id },
        { ...github, kiloUserId: destinationUser.id }
      )
    ).resolves.toMatchObject({ ok: true });
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

  it('explicitly removes personal and organization attempts during soft deletion', async () => {
    const personal = await insertTestUser();
    await beginProviderOAuthAttempt({
      actorUserId: personal.id,
      owner: { type: 'user', id: personal.id },
      provider: 'slack',
      state: 'personal-delete',
    });
    await db.transaction(tx => anonymizeCloudUserData(tx, personal.id));
    await expect(
      db
        .select()
        .from(provider_oauth_attempts)
        .where(eq(provider_oauth_attempts.owned_by_user_id, personal.id))
    ).resolves.toHaveLength(0);

    const orgOwner = await insertTestUser();
    const organization = await createTestOrganization('Attempt deletion org', orgOwner.id, 0);
    await beginProviderOAuthAttempt({
      actorUserId: orgOwner.id,
      owner: { type: 'org', id: organization.id },
      provider: 'linear',
      state: 'org-delete',
    });
    await markOrganizationAsDeleted(organization.id);
    await expect(
      db
        .select()
        .from(provider_oauth_attempts)
        .where(eq(provider_oauth_attempts.owned_by_organization_id, organization.id))
    ).resolves.toHaveLength(0);
  });

  it('globally prunes another owner expired retention row without touching active attempts', async () => {
    const oldOwner = await insertTestUser();
    const activeOwner = await insertTestUser();
    await db.insert(provider_oauth_attempts).values({
      provider: 'discord',
      purpose: 'provider_install',
      state_hash: 'old-hash',
      initiated_by_user_id: oldOwner.id,
      owned_by_user_id: oldOwner.id,
      status: 'expired',
      expires_at: '2020-01-01T00:00:00.000Z',
    });
    await beginProviderOAuthAttempt({
      actorUserId: activeOwner.id,
      owner: { type: 'user', id: activeOwner.id },
      provider: 'slack',
      state: 'active-state',
      purpose: 'provider_install',
    });

    await expect(
      db
        .select()
        .from(provider_oauth_attempts)
        .where(eq(provider_oauth_attempts.state_hash, 'old-hash'))
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(provider_oauth_attempts).where(eq(provider_oauth_attempts.status, 'pending'))
    ).resolves.toHaveLength(1);
  });

  it('cancels a missing-code attempt once and permits an immediate retry', async () => {
    const actor = await insertTestUser();
    const owner = { type: 'user' as const, id: actor.id };
    await beginProviderOAuthAttempt({
      actorUserId: actor.id,
      owner,
      provider: 'discord',
      state: 'cancel-state',
      purpose: 'provider_install',
    });
    await expect(
      cancelProviderOAuthAttempt({
        actorUserId: actor.id,
        owner,
        provider: 'discord',
        state: 'cancel-state',
        purpose: 'provider_install',
      })
    ).resolves.toBe(true);
    await expect(
      cancelProviderOAuthAttempt({
        actorUserId: actor.id,
        owner,
        provider: 'discord',
        state: 'cancel-state',
        purpose: 'provider_install',
      })
    ).resolves.toBe(false);
    await expect(
      beginProviderOAuthAttempt({
        actorUserId: actor.id,
        owner,
        provider: 'discord',
        state: 'retry-state',
        purpose: 'provider_install',
      })
    ).resolves.toBeUndefined();
  });

  it('blocks attach on a held reservation owner row before rejecting it', async () => {
    const a = await insertTestUser();
    const b = await insertTestUser();
    const orgA = await createTestOrganization('Row lock A', a.id, 0);
    const orgB = await createTestOrganization('Row lock B', b.id, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = orgB.id;
    const github = {
      platformInstallationId: '880003',
      githubAppType: 'standard' as const,
      platformAccountId: '101',
      platformAccountLogin: 'acme',
      githubUserId: '101',
      accountType: 'Organization' as const,
      scopes: [],
      installedAt: new Date().toISOString(),
      repositoryAccess: 'all',
      repositories: [],
      permissions: {},
      kiloUserId: a.id,
    };
    await connectVerifiedGitHubInstallation({ type: 'org', id: orgA.id }, github);
    let release: (() => void) | undefined;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    let locked: ((pid: number) => void) | undefined;
    const lockedRow = new Promise<number>(resolve => {
      locked = resolve;
    });
    const reservation = db.transaction(async tx => {
      await tx
        .select({ id: organizations.id })
        .from(organizations)
        .where(eq(organizations.id, orgB.id))
        .for('update');
      const backend = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      await tx.insert(provider_oauth_attempts).values({
        provider: 'slack',
        purpose: 'provider_install',
        state_hash: 'barrier-hash',
        initiated_by_user_id: b.id,
        owned_by_organization_id: orgB.id,
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
      locked?.(backend.rows[0]!.pid);
      await barrier;
    });
    let settled = false;
    let attach: ReturnType<typeof connectVerifiedGitHubInstallation> | undefined;
    let observationError: unknown;
    try {
      const holderPid = await withTestTimeout(lockedRow, 'reservation holder readiness');
      attach = connectVerifiedGitHubInstallation(
        { type: 'org', id: orgB.id },
        { ...github, kiloUserId: b.id }
      ).finally(() => {
        settled = true;
      });
      await withTestTimeout(
        waitForBlockedOwnerRowQuery(holderPid),
        'attach owner-row lock observation'
      );
      expect(settled).toBe(false);
    } catch (error) {
      observationError = error;
    } finally {
      release?.();
    }
    const [reservationResult, attachResult] = await Promise.allSettled([
      reservation,
      attach ?? Promise.reject(new Error('Attach did not start')),
    ]);
    if (observationError) throw observationError;
    expect(reservationResult.status).toBe('fulfilled');
    expect(attachResult).toEqual({
      status: 'fulfilled',
      value: { ok: false, reason: 'incompatible_workflow' },
    });
  });

  it('blocks reservation on the attach owner row until sharing commits', async () => {
    const a = await insertTestUser();
    const b = await insertTestUser();
    const orgA = await createTestOrganization('Attach row A', a.id, 0);
    const orgB = await createTestOrganization('Attach row B', b.id, 0);
    process.env.GITHUB_SHARED_INSTALLATION_ORGANIZATION_IDS = orgB.id;
    const github = {
      platformInstallationId: '880004',
      githubAppType: 'standard' as const,
      platformAccountId: '102',
      platformAccountLogin: 'acme',
      githubUserId: '102',
      accountType: 'Organization' as const,
      scopes: [],
      installedAt: new Date().toISOString(),
      repositoryAccess: 'all',
      repositories: [],
      permissions: {},
      kiloUserId: a.id,
    };
    await connectVerifiedGitHubInstallation({ type: 'org', id: orgA.id }, github);
    let release: (() => void) | undefined;
    const barrier = new Promise<void>(resolve => {
      release = resolve;
    });
    let attached: ((pid: number) => void) | undefined;
    const attachedBeforeCommit = new Promise<number>(resolve => {
      attached = resolve;
    });
    const attach = db.transaction(async tx => {
      const result = await connectVerifiedGitHubInstallation(
        { type: 'org', id: orgB.id },
        { ...github, kiloUserId: b.id },
        tx
      );
      const backend = await tx.execute<{ pid: number }>(sql`SELECT pg_backend_pid() AS pid`);
      attached?.(backend.rows[0]!.pid);
      await barrier;
      return result;
    });
    let settled = false;
    let start: ReturnType<typeof beginProviderOAuthAttempt> | undefined;
    let observationError: unknown;
    try {
      const holderPid = await withTestTimeout(attachedBeforeCommit, 'attach holder readiness');
      start = beginProviderOAuthAttempt({
        actorUserId: b.id,
        owner: { type: 'org', id: orgB.id },
        provider: 'linear',
        state: 'blocked-start',
        purpose: 'provider_install',
      }).finally(() => {
        settled = true;
      });
      await withTestTimeout(
        waitForBlockedOwnerRowQuery(holderPid),
        'reservation owner-row lock observation'
      );
      expect(settled).toBe(false);
    } catch (error) {
      observationError = error;
    } finally {
      release?.();
    }
    const [attachResult, startResult] = await Promise.allSettled([
      attach,
      start ?? Promise.reject(new Error('Reservation did not start')),
    ]);
    if (observationError) throw observationError;
    expect(attachResult).toMatchObject({ status: 'fulfilled', value: { ok: true } });
    expect(startResult.status).toBe('rejected');
    if (startResult.status === 'rejected') {
      expect(startResult.reason).toEqual(
        expect.objectContaining({
          message: 'This workflow is not available for shared GitHub installations yet',
        })
      );
    }
  });
});

async function waitForBlockedOwnerRowQuery(holderPid: number): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await db.execute<{ blocked: boolean }>(sql`
      SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database()
          AND ${holderPid} = ANY(pg_blocking_pids(pid))
          AND wait_event_type = 'Lock'
          AND lower(query) LIKE '%organizations%'
          AND lower(query) LIKE '%for update%'
      ) AS blocked
    `);
    if (result.rows[0]?.blocked) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error('Expected a transaction blocked on the organization owner row');
}

async function withTestTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out`)), 5_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
