import { beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { GitLabCredentialBrokerResult } from '@/lib/integrations/platforms/gitlab/credential-broker-client';
import type { PlatformIntegration } from '@kilocode/db/schema';
import type { isGitLabCredentialConnected as IsGitLabCredentialConnected } from './gitlab-service';

const mockFetchGitLabCredential = jest.fn<() => Promise<GitLabCredentialBrokerResult>>();

jest.mock('@/lib/integrations/platforms/gitlab/credential-broker-client', () => ({
  fetchGitLabCredential: (...args: unknown[]) => mockFetchGitLabCredential(...(args as [])),
}));

// `gitlab-service` imports the db module at load time; the status helper under
// test never touches it, so a stub keeps this suite dependency-free.
jest.mock('@kilocode/web-shared/lib/drizzle', () => ({ db: {} }));

let isGitLabCredentialConnected: typeof IsGitLabCredentialConnected;

beforeAll(async () => {
  ({ isGitLabCredentialConnected } = await import('./gitlab-service'));
});

describe('isGitLabCredentialConnected', () => {
  const integration = { id: '11111111-1111-4111-8111-111111111111' } as PlatformIntegration;
  const actor = { userId: 'user-1' };

  beforeEach(() => {
    mockFetchGitLabCredential.mockReset();
  });

  it('asks the broker to resolve the integration credential', async () => {
    mockFetchGitLabCredential.mockResolvedValue({
      status: 'available',
      token: 'token',
      instanceUrl: 'https://gitlab.com',
      glabIsOAuth2: true,
    });
    await isGitLabCredentialConnected(integration, actor);
    expect(mockFetchGitLabCredential).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ credential: 'integration', integrationId: integration.id })
    );
  });

  it('answers connected when the broker releases the credential', async () => {
    mockFetchGitLabCredential.mockResolvedValue({
      status: 'available',
      token: 'token',
      instanceUrl: 'https://gitlab.com',
      glabIsOAuth2: true,
    });
    await expect(isGitLabCredentialConnected(integration, actor)).resolves.toBe(true);
  });

  it.each(['reconnect_required', 'not_connected'] as const)(
    'answers disconnected on a definitive broker refusal (%s)',
    async status => {
      mockFetchGitLabCredential.mockResolvedValue({ status });
      await expect(isGitLabCredentialConnected(integration, actor)).resolves.toBe(false);
    }
  );

  it('fails open when the broker is temporarily unavailable', async () => {
    mockFetchGitLabCredential.mockResolvedValue({ status: 'temporarily_unavailable' });
    await expect(isGitLabCredentialConnected(integration, actor)).resolves.toBe(true);
  });
});
