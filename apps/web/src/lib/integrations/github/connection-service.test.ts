import { cleanupDbForTest, db } from '@/lib/drizzle';
import { github_connection_attempts } from '@kilocode/db/schema';
import { eq } from 'drizzle-orm';
import {
  createGitHubConnectionAttempt,
  getGitHubConnectionAttempt,
  recordGitHubConnectionDiscovery,
  selectGitHubConnectionInstallation,
} from './connection-service';

const userId = 'oauth/github-picker-user';
const organizationId = '00000000-0000-4000-8000-000000000001';
const candidate = {
  installationId: '123',
  accountId: '456',
  accountLogin: 'acme',
  accountType: 'Organization' as const,
};

describe('GitHub connection attempt persistence', () => {
  beforeEach(cleanupDbForTest);
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
});
