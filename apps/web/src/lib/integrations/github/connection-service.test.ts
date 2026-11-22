import { cleanupDbForTest, db } from '@kilocode/web-shared/lib/drizzle';
import {
  github_connection_attempts,
  kilocode_users,
  platform_integrations,
} from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  createGitHubConnectionAttempt,
  completeGitHubConnectionAttempt,
  getGitHubConnectionAttempt,
  recordGitHubConnectionDiscovery,
  selectGitHubConnectionInstallation,
} from './connection-service';
import {
  fetchGitHubInstallationDetails,
  fetchGitHubRepositoriesForMaintenance,
} from '@/lib/integrations/platforms/github/adapter';
import {
  connectVerifiedGitHubInstallation,
  disconnectGitHubInstallation,
} from '@/lib/integrations/db/github-installations';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

const mockLogExceptInTest = jest.fn();

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/utils.server'),
  logExceptInTest: (...args: unknown[]) => mockLogExceptInTest(...args),
}));

jest.mock('@/lib/integrations/platforms/github/adapter', () => ({
  fetchGitHubInstallationDetails: jest.fn(),
  fetchGitHubRepositoriesForMaintenance: jest.fn(),
}));

const mockedFetchInstallation = jest.mocked(fetchGitHubInstallationDetails);
const mockedFetchRepositories = jest.mocked(fetchGitHubRepositoriesForMaintenance);

const userId = 'oauth/github-picker-user';
const organizationId = '00000000-0000-4000-8000-000000000001';
const candidate = {
  installationId: '123',
  accountId: '456',
  accountLogin: 'acme',
  accountType: 'Organization' as const,
};

describe('GitHub connection attempt persistence', () => {
  beforeEach(async () => {
    mockLogExceptInTest.mockClear();
    await cleanupDbForTest();
    await db.insert(kilocode_users).values({
      id: userId,
      google_user_email: 'picker@example.com',
      google_user_name: 'Picker',
      google_user_image_url: '',
      stripe_customer_id: 'cus_picker',
    });
    mockedFetchInstallation.mockResolvedValue({
      id: 123,
      account: { id: 456, login: 'picker', type: 'User' },
      permissions: { contents: 'read' },
      events: ['push'],
      repository_selection: 'all',
      created_at: '2026-09-07T00:00:00.000Z',
    } as never);
    mockedFetchRepositories.mockResolvedValue([]);
  });
  afterEach(cleanupDbForTest);

  test('binds discovery and selection to the initiating user and eligible candidate', async () => {
    const attemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'org', id: organizationId },
      githubAppType: 'standard',
      returnTo: null,
    });
    await expect(
      recordGitHubConnectionDiscovery({
        attemptId,
        userId: 'oauth/other-user',
        githubUserId: '7',
        candidates: [candidate],
      })
    ).resolves.toBeNull();
    await recordGitHubConnectionDiscovery({
      attemptId,
      userId,
      githubUserId: '7',
      candidates: [candidate],
    });
    await expect(
      selectGitHubConnectionInstallation({
        attemptId,
        userId,
        installationId: '999',
      })
    ).resolves.toBeNull();
    await expect(
      selectGitHubConnectionInstallation({
        attemptId,
        userId,
        installationId: candidate.installationId,
      })
    ).resolves.toMatchObject({ selected_installation_id: candidate.installationId });
    await expect(getGitHubConnectionAttempt(attemptId, userId)).resolves.toMatchObject({
      ownerId: organizationId,
      ownerType: 'org',
      candidates: [candidate],
    });
  });

  test('rejects an expired picker without changing its selection', async () => {
    const attemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'org', id: organizationId },
      githubAppType: 'lite',
      returnTo: null,
    });
    await db
      .update(github_connection_attempts)
      .set({ expires_at: '2020-01-01T00:00:00.000Z', eligible_installations: [candidate] })
      .where(eq(github_connection_attempts.id, attemptId));
    await expect(
      selectGitHubConnectionInstallation({
        attemptId,
        userId,
        installationId: candidate.installationId,
      })
    ).resolves.toBeNull();
    const [attempt] = await db
      .select({ selected: github_connection_attempts.selected_installation_id })
      .from(github_connection_attempts)
      .where(eq(github_connection_attempts.id, attemptId));
    expect(attempt?.selected).toBeNull();
  });

  test('allows only one concurrent tab to bind the confirmation selection', async () => {
    const attemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'org', id: organizationId },
      githubAppType: 'standard',
      returnTo: null,
    });
    const secondCandidate = { ...candidate, installationId: '124', accountLogin: 'acme-two' };
    await recordGitHubConnectionDiscovery({
      attemptId,
      userId,
      githubUserId: '7',
      candidates: [candidate, secondCandidate],
    });
    const selections = await Promise.all([
      selectGitHubConnectionInstallation({
        attemptId,
        userId,
        installationId: candidate.installationId,
      }),
      selectGitHubConnectionInstallation({
        attemptId,
        userId,
        installationId: secondCandidate.installationId,
      }),
    ]);
    expect(selections.filter(Boolean)).toHaveLength(1);
    const [stored] = await db
      .select({ selected: github_connection_attempts.selected_installation_id })
      .from(github_connection_attempts)
      .where(eq(github_connection_attempts.id, attemptId));
    expect([candidate.installationId, secondCandidate.installationId]).toContain(stored?.selected);
    if (!stored?.selected) throw new Error('Expected one selected installation');
    await expect(
      selectGitHubConnectionInstallation({ attemptId, userId, installationId: stored.selected })
    ).resolves.toMatchObject({ selected_installation_id: stored.selected });
  });

  test('caches the repository inventory for an all-repositories attach so first-use discovery works', async () => {
    mockedFetchInstallation.mockResolvedValue({
      id: 123,
      account: { id: 456, login: 'acme', type: 'Organization' },
      permissions: { contents: 'read' },
      events: ['push'],
      repository_selection: 'all',
      created_at: '2026-09-07T00:00:00.000Z',
    } as never);
    mockedFetchRepositories.mockResolvedValue([
      {
        id: 1,
        name: 'repo',
        full_name: 'acme/repo',
        private: false,
        created_at: '2026-09-07T00:00:00.000Z',
      },
    ] as never);

    const organization = await createTestOrganization('Attach inventory org', userId, 0);
    const attemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'org', id: organization.id },
      githubAppType: 'standard',
      returnTo: null,
    });
    await recordGitHubConnectionDiscovery({
      attemptId,
      userId,
      githubUserId: '456',
      candidates: [candidate],
    });
    await selectGitHubConnectionInstallation({
      attemptId,
      userId,
      installationId: candidate.installationId,
    });

    const completed = await completeGitHubConnectionAttempt({
      attemptId,
      userId,
      githubUserId: '456',
      candidate,
      authorizeOwner: async () => {},
    });
    if (!completed.ok) throw new Error('Expected completion');

    // The installation exposes all repositories, so the attach must still
    // populate the cache rather than leaving repositories=null.
    expect(mockedFetchRepositories).toHaveBeenCalledWith(candidate.installationId, 'standard');
    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, completed.integrationId));
    expect(row?.repositories).toHaveLength(1);
    expect(row?.repository_access).toBe('all');
  });

  test('a failing inventory listing does not block an all-repositories attach', async () => {
    mockedFetchInstallation.mockResolvedValue({
      id: 123,
      account: { id: 456, login: 'acme', type: 'Organization' },
      permissions: { contents: 'read' },
      events: ['push'],
      repository_selection: 'all',
      created_at: '2026-09-07T00:00:00.000Z',
    } as never);
    mockedFetchRepositories.mockRejectedValueOnce(new Error('rate limited'));

    const organization = await createTestOrganization('Attach inventory failure org', userId, 0);
    const attemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'org', id: organization.id },
      githubAppType: 'standard',
      returnTo: null,
    });
    await recordGitHubConnectionDiscovery({
      attemptId,
      userId,
      githubUserId: '456',
      candidates: [candidate],
    });
    await selectGitHubConnectionInstallation({
      attemptId,
      userId,
      installationId: candidate.installationId,
    });

    // The inventory sync is best-effort for all-repositories installs: a
    // transient listing failure must not abort the connection.
    const completed = await completeGitHubConnectionAttempt({
      attemptId,
      userId,
      githubUserId: '456',
      candidate,
      authorizeOwner: async () => {},
    });
    if (!completed.ok) throw new Error('Expected completion');

    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, completed.integrationId));
    expect(row).toMatchObject({ integration_status: 'active', repository_access: 'all' });
    expect(row?.repositories).toBeNull();
  });

  test('atomically writes, consumes, and idempotently replays a verified completion', async () => {
    const personalCandidate = {
      ...candidate,
      accountLogin: 'picker',
      accountType: 'User' as const,
    };
    const attemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'user', id: userId },
      githubAppType: 'standard',
      returnTo: null,
    });
    await recordGitHubConnectionDiscovery({
      attemptId,
      userId,
      githubUserId: '456',
      candidates: [personalCandidate],
    });
    await selectGitHubConnectionInstallation({ attemptId, userId, installationId: '123' });
    const input = {
      attemptId,
      userId,
      githubUserId: '456',
      candidate: personalCandidate,
      authorizeOwner: async () => {},
    };
    const completed = await completeGitHubConnectionAttempt(input);
    expect(completed.ok).toBe(true);
    if (!completed.ok) throw new Error('Expected completed connection');
    await expect(completeGitHubConnectionAttempt(input)).resolves.toEqual(completed);
    const [attempt] = await db
      .select()
      .from(github_connection_attempts)
      .where(eq(github_connection_attempts.id, attemptId));
    expect(attempt).toMatchObject({
      completed_integration_id: completed.integrationId,
      consumed_at: expect.any(String),
    });
    await expect(
      db
        .select()
        .from(platform_integrations)
        .where(eq(platform_integrations.id, completed.integrationId))
    ).resolves.toHaveLength(1);

    // Authorization provenance must reflect the identity that actually
    // completed the connection, not be left null.
    const [integrationRow] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, completed.integrationId));
    expect(integrationRow).toMatchObject({
      github_authorized_by_user_id: userId,
      github_authorized_user_id: '456',
      github_authorized_at: expect.any(String),
    });
  });

  test('completes a fresh connection attempt for the same installation after a prior local disconnect', async () => {
    const personalCandidate = {
      ...candidate,
      accountLogin: 'picker',
      accountType: 'User' as const,
    };
    const firstAttemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'user', id: userId },
      githubAppType: 'standard',
      returnTo: null,
    });
    await recordGitHubConnectionDiscovery({
      attemptId: firstAttemptId,
      userId,
      githubUserId: '456',
      candidates: [personalCandidate],
    });
    await selectGitHubConnectionInstallation({
      attemptId: firstAttemptId,
      userId,
      installationId: '123',
    });
    const firstCompleted = await completeGitHubConnectionAttempt({
      attemptId: firstAttemptId,
      userId,
      githubUserId: '456',
      candidate: personalCandidate,
      authorizeOwner: async () => {},
    });
    expect(firstCompleted.ok).toBe(true);
    if (!firstCompleted.ok) throw new Error('Expected initial completion');

    await disconnectGitHubInstallation({ type: 'user', id: userId }, firstCompleted.integrationId);

    const secondAttemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'user', id: userId },
      githubAppType: 'standard',
      returnTo: null,
    });
    await recordGitHubConnectionDiscovery({
      attemptId: secondAttemptId,
      userId,
      githubUserId: '456',
      candidates: [personalCandidate],
    });
    await selectGitHubConnectionInstallation({
      attemptId: secondAttemptId,
      userId,
      installationId: '123',
    });
    const secondCompleted = await completeGitHubConnectionAttempt({
      attemptId: secondAttemptId,
      userId,
      githubUserId: '456',
      candidate: personalCandidate,
      authorizeOwner: async () => {},
    });
    expect(secondCompleted).toEqual({ ok: true, integrationId: firstCompleted.integrationId });

    const [row] = await db
      .select()
      .from(platform_integrations)
      .where(eq(platform_integrations.id, firstCompleted.integrationId));
    expect(row).toMatchObject({ github_disconnected_at: null, integration_status: 'active' });
  });

  test('logs a committed workflow-role transfer itself and keeps its public result shape', async () => {
    const holderId = 'oauth/github-picker-blocked-holder';
    await db.insert(kilocode_users).values({
      id: holderId,
      google_user_email: 'holder@example.com',
      google_user_name: 'Holder',
      google_user_image_url: '',
      stripe_customer_id: 'cus_holder',
    });
    const personalCandidate = {
      ...candidate,
      accountLogin: 'picker',
      accountType: 'User' as const,
    };
    const holder = await connectVerifiedGitHubInstallation(
      { type: 'user', id: holderId },
      {
        platformInstallationId: candidate.installationId,
        platformAccountId: candidate.accountId,
        platformAccountLogin: personalCandidate.accountLogin,
        permissions: { contents: 'read' },
        scopes: ['push'],
        repositoryAccess: 'all',
        repositories: null,
        installedAt: '2026-09-07T00:00:00.000Z',
        githubAppType: 'standard',
        kiloUserId: holderId,
        githubUserId: '456',
        accountType: 'User',
      }
    );
    if (!holder.ok) throw new Error('Expected the holder to connect');
    // A blocked account no longer holds the installation, so completing for the
    // other verified owner transfers the workflow role.
    await db
      .update(kilocode_users)
      .set({ blocked_reason: 'test block' })
      .where(eq(kilocode_users.id, holderId));

    const attemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'user', id: userId },
      githubAppType: 'standard',
      returnTo: null,
    });
    await recordGitHubConnectionDiscovery({
      attemptId,
      userId,
      githubUserId: '456',
      candidates: [personalCandidate],
    });
    await selectGitHubConnectionInstallation({
      attemptId,
      userId,
      installationId: candidate.installationId,
    });

    const completed = await completeGitHubConnectionAttempt({
      attemptId,
      userId,
      githubUserId: '456',
      candidate: personalCandidate,
      authorizeOwner: async () => {},
    });
    if (!completed.ok) throw new Error('Expected completion');

    // The public result stays the plain success shape, and this caller logged
    // the transfer itself after its transaction committed.
    expect(Object.keys(completed).sort()).toEqual(['integrationId', 'ok']);
    expect(mockLogExceptInTest).toHaveBeenCalledWith(
      '[connectVerifiedGitHubInstallation] Workflow role transferred',
      expect.objectContaining({
        installationId: candidate.installationId,
        integrationId: holder.integrationId,
        demotedTo: 'agent_only',
        reason: 'blocked_personal_owner',
        successorOwner: `user:${userId}`,
      })
    );
    expect(mockLogExceptInTest).toHaveBeenCalledTimes(1);
    await expect(
      db
        .select({ role: platform_integrations.github_connection_role })
        .from(platform_integrations)
        .where(eq(platform_integrations.id, holder.integrationId))
    ).resolves.toEqual([{ role: 'agent_only' }]);
  });

  test('rejects completion when verified identity does not match the locked attempt', async () => {
    const attemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'user', id: userId },
      githubAppType: 'standard',
      returnTo: null,
    });
    await recordGitHubConnectionDiscovery({
      attemptId,
      userId,
      githubUserId: '456',
      candidates: [candidate],
    });
    await selectGitHubConnectionInstallation({ attemptId, userId, installationId: '123' });
    await expect(
      completeGitHubConnectionAttempt({
        attemptId,
        userId,
        githubUserId: '999',
        candidate,
        authorizeOwner: async () => {},
      })
    ).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
  });

  test('rejects direct completion after expiry or when selection changed', async () => {
    const attemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'user', id: userId },
      githubAppType: 'standard',
      returnTo: null,
    });
    await recordGitHubConnectionDiscovery({
      attemptId,
      userId,
      githubUserId: '456',
      candidates: [candidate],
    });
    await selectGitHubConnectionInstallation({ attemptId, userId, installationId: '123' });
    const input = {
      attemptId,
      userId,
      githubUserId: '456',
      candidate,
      authorizeOwner: async (owner: { type: 'user' | 'org'; id: string }) => {
        expect(owner).toEqual({ type: 'user', id: userId });
      },
    };
    await db
      .update(github_connection_attempts)
      .set({ expires_at: '2020-01-01T00:00:00.000Z' })
      .where(eq(github_connection_attempts.id, attemptId));
    await expect(completeGitHubConnectionAttempt(input)).resolves.toEqual({
      ok: false,
      reason: 'installation_unavailable',
    });
    await db
      .update(github_connection_attempts)
      .set({
        expires_at: '2099-01-01T00:00:00.000Z',
        selected_installation_id: '999',
      })
      .where(eq(github_connection_attempts.id, attemptId));
    await expect(completeGitHubConnectionAttempt(input)).resolves.toEqual({
      ok: false,
      reason: 'installation_unavailable',
    });
  });

  // Creates an attempt that is discovered and selected for `candidate`, so the
  // only thing left before completion is the call itself.
  const prepareSelectedAttempt = async (githubUserId = '456') => {
    const attemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'user', id: userId },
      githubAppType: 'standard',
      returnTo: null,
    });
    await recordGitHubConnectionDiscovery({
      attemptId,
      userId,
      githubUserId,
      candidates: [candidate],
    });
    await selectGitHubConnectionInstallation({
      attemptId,
      userId,
      installationId: candidate.installationId,
    });
    return attemptId;
  };

  test('returns installation_unavailable when the candidate installation is not a recorded eligible entry', async () => {
    mockedFetchInstallation.mockClear();
    mockedFetchRepositories.mockClear();
    const attemptId = await prepareSelectedAttempt();
    // Set the stored selection directly, so completion must resolve both the
    // selection and the candidate against the recorded eligible entries.
    await db
      .update(github_connection_attempts)
      .set({ selected_installation_id: '999' })
      .where(eq(github_connection_attempts.id, attemptId));
    await expect(
      completeGitHubConnectionAttempt({
        attemptId,
        userId,
        githubUserId: '456',
        candidate: { ...candidate, installationId: '999' },
        authorizeOwner: async () => {},
      })
    ).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
    expect(mockedFetchInstallation).not.toHaveBeenCalled();
    expect(mockedFetchRepositories).not.toHaveBeenCalled();
  });

  test('returns installation_unavailable when the candidate account fields differ from the recorded entry', async () => {
    mockedFetchInstallation.mockClear();
    mockedFetchRepositories.mockClear();
    const attemptId = await prepareSelectedAttempt();
    const mismatches = [
      { ...candidate, accountId: '789' },
      { ...candidate, accountLogin: 'evil' },
      { ...candidate, accountType: 'User' as const },
    ];
    for (const submitted of mismatches) {
      await expect(
        completeGitHubConnectionAttempt({
          attemptId,
          userId,
          githubUserId: '456',
          candidate: submitted,
          authorizeOwner: async () => {},
        })
      ).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
    }
    expect(mockedFetchInstallation).not.toHaveBeenCalled();
    expect(mockedFetchRepositories).not.toHaveBeenCalled();
  });

  test('returns installation_unavailable when the attempt belongs to a different GitHub identity', async () => {
    mockedFetchInstallation.mockClear();
    mockedFetchRepositories.mockClear();
    const attemptId = await prepareSelectedAttempt('456');
    await expect(
      completeGitHubConnectionAttempt({
        attemptId,
        userId,
        githubUserId: '999',
        candidate,
        authorizeOwner: async () => {},
      })
    ).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
    expect(mockedFetchInstallation).not.toHaveBeenCalled();
    expect(mockedFetchRepositories).not.toHaveBeenCalled();
  });

  test('returns installation_unavailable when the attempt belongs to a different Kilo user', async () => {
    mockedFetchInstallation.mockClear();
    mockedFetchRepositories.mockClear();
    const otherUserId = 'oauth/github-picker-other-user';
    await db.insert(kilocode_users).values({
      id: otherUserId,
      google_user_email: 'other@example.com',
      google_user_name: 'Other',
      google_user_image_url: '',
      stripe_customer_id: 'cus_other',
    });
    const attemptId = await createGitHubConnectionAttempt({
      kiloUserId: otherUserId,
      owner: { type: 'user', id: otherUserId },
      githubAppType: 'standard',
      returnTo: null,
    });
    await recordGitHubConnectionDiscovery({
      attemptId,
      userId: otherUserId,
      githubUserId: '456',
      candidates: [candidate],
    });
    await selectGitHubConnectionInstallation({
      attemptId,
      userId: otherUserId,
      installationId: candidate.installationId,
    });
    await expect(
      completeGitHubConnectionAttempt({
        attemptId,
        userId,
        githubUserId: '456',
        candidate,
        authorizeOwner: async () => {},
      })
    ).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
    expect(mockedFetchInstallation).not.toHaveBeenCalled();
    expect(mockedFetchRepositories).not.toHaveBeenCalled();
  });

  test('returns installation_unavailable for a consumed attempt without a completed connection', async () => {
    mockedFetchInstallation.mockClear();
    mockedFetchRepositories.mockClear();
    const attemptId = await prepareSelectedAttempt();
    await db
      .update(github_connection_attempts)
      .set({ consumed_at: new Date().toISOString() })
      .where(eq(github_connection_attempts.id, attemptId));
    await expect(
      completeGitHubConnectionAttempt({
        attemptId,
        userId,
        githubUserId: '456',
        candidate,
        authorizeOwner: async () => {},
      })
    ).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
    expect(mockedFetchInstallation).not.toHaveBeenCalled();
    expect(mockedFetchRepositories).not.toHaveBeenCalled();
  });

  test('returns installation_unavailable when the recorded installation id is not canonical', async () => {
    mockedFetchInstallation.mockClear();
    mockedFetchRepositories.mockClear();
    const nonCanonical = { ...candidate, installationId: '0123' };
    const attemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'user', id: userId },
      githubAppType: 'standard',
      returnTo: null,
    });
    await recordGitHubConnectionDiscovery({
      attemptId,
      userId,
      githubUserId: '456',
      candidates: [nonCanonical],
    });
    await selectGitHubConnectionInstallation({
      attemptId,
      userId,
      installationId: nonCanonical.installationId,
    });
    await expect(
      completeGitHubConnectionAttempt({
        attemptId,
        userId,
        githubUserId: '456',
        candidate: nonCanonical,
        authorizeOwner: async () => {},
      })
    ).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
    expect(mockedFetchInstallation).not.toHaveBeenCalled();
    expect(mockedFetchRepositories).not.toHaveBeenCalled();
  });

  test('returns installation_unavailable when the submitted installation id is not canonical', async () => {
    mockedFetchInstallation.mockClear();
    mockedFetchRepositories.mockClear();
    const nonCanonical = { ...candidate, installationId: '12a' };
    const attemptId = await createGitHubConnectionAttempt({
      kiloUserId: userId,
      owner: { type: 'user', id: userId },
      githubAppType: 'standard',
      returnTo: null,
    });
    await recordGitHubConnectionDiscovery({
      attemptId,
      userId,
      githubUserId: '456',
      candidates: [nonCanonical],
    });
    await selectGitHubConnectionInstallation({
      attemptId,
      userId,
      installationId: nonCanonical.installationId,
    });
    await expect(
      completeGitHubConnectionAttempt({
        attemptId,
        userId,
        githubUserId: '456',
        candidate: nonCanonical,
        authorizeOwner: async () => {},
      })
    ).resolves.toEqual({ ok: false, reason: 'installation_unavailable' });
    expect(mockedFetchInstallation).not.toHaveBeenCalled();
    expect(mockedFetchRepositories).not.toHaveBeenCalled();
  });
});
