import { cleanupDbForTest, db } from '@/lib/drizzle';
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
});
