import { signKiloToken } from '@kilocode/worker-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  findManagedInstallationForRepo: vi.fn(),
  getTokenForRepo: vi.fn(),
  selectUserAuthorization: vi.fn(),
  disconnectUserAuthorization: vi.fn(),
}));

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;

    constructor(_ctx: unknown, env: unknown) {
      this.env = env;
    }
  },
}));

vi.mock('./github-token-service.js', () => ({
  GitHubTokenService: class GitHubTokenService {
    getTokenForRepo = serviceMocks.getTokenForRepo;
  },
}));

vi.mock('./installation-lookup-service.js', () => ({
  InstallationLookupService: class InstallationLookupService {
    findManagedInstallationForRepo = serviceMocks.findManagedInstallationForRepo;
  },
}));

vi.mock('./github-user-authorization-service.js', () => ({
  GitHubUserAuthorizationService: class GitHubUserAuthorizationService {
    selectUserAuthorization = serviceMocks.selectUserAuthorization;
    disconnectUserAuthorization = serviceMocks.disconnectUserAuthorization;
  },
}));

vi.mock('./gitlab-lookup-service.js', () => ({
  GitLabLookupService: class GitLabLookupService {},
}));

vi.mock('./gitlab-token-service.js', () => ({
  GitLabTokenService: class GitLabTokenService {},
}));

import handler, { GitTokenRPCEntrypoint } from './index.js';

function createService(): GitTokenRPCEntrypoint {
  return new GitTokenRPCEntrypoint(
    {} as ExecutionContext,
    {
      GITHUB_APP_SLUG: 'kiloconnect',
      GITHUB_APP_BOT_USER_ID: '240665456',
    } as CloudflareEnv
  );
}

describe('GitTokenRPCEntrypoint.getCloudAgentAuthForRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.findManagedInstallationForRepo.mockResolvedValue({
      success: true,
      installationId: '123',
      accountLogin: 'acme',
      githubAppType: 'standard',
      repoName: 'repo',
      permissions: { contents: 'write', pull_requests: 'write' },
    });
    serviceMocks.getTokenForRepo.mockResolvedValue('installation-token');
    serviceMocks.selectUserAuthorization.mockResolvedValue({
      selected: true,
      token: 'user-token',
      gitAuthor: { name: 'octocat', email: '1+octocat@users.noreply.github.com' },
    });
  });

  it('uses installation identity when personal authorization is not allowed', async () => {
    const result = await createService().getCloudAgentAuthForRepo({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      allowUserAuthorization: false,
    });

    expect(serviceMocks.selectUserAuthorization).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      githubToken: 'installation-token',
      source: 'installation',
      gitAuthor: {
        name: 'kiloconnect[bot]',
        email: '240665456+kiloconnect[bot]@users.noreply.github.com',
      },
    });
  });

  it('defaults to installation identity when eligibility is omitted', async () => {
    const result = await createService().getCloudAgentAuthForRepo({
      githubRepo: 'acme/repo',
      userId: 'user_1',
    });

    expect(serviceMocks.selectUserAuthorization).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      githubToken: 'installation-token',
      source: 'installation',
    });
  });

  it('uses personal authorization only when it is explicitly allowed', async () => {
    const result = await createService().getCloudAgentAuthForRepo({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      allowUserAuthorization: true,
    });

    expect(serviceMocks.selectUserAuthorization).toHaveBeenCalledOnce();
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      success: true,
      githubToken: 'user-token',
      source: 'user',
      gitAuthor: { name: 'octocat', email: '1+octocat@users.noreply.github.com' },
      commitCoAuthor: {
        name: 'kiloconnect[bot]',
        email: '240665456+kiloconnect[bot]@users.noreply.github.com',
      },
    });
  });

  it.each(['credential_unreadable', 'credential_configuration_error'] as const)(
    'uses installation identity when selection reports %s',
    async reason => {
      serviceMocks.selectUserAuthorization.mockResolvedValueOnce({ selected: false, reason });

      const result = await createService().getCloudAgentAuthForRepo({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        allowUserAuthorization: true,
      });

      expect(result).toMatchObject({
        success: true,
        githubToken: 'installation-token',
        source: 'installation',
        fallbackReason: reason,
      });
    }
  );
});

describe('fetch disconnect endpoint', () => {
  const jwtSecret = 'test-secret-that-is-at-least-32-characters';
  const env = {
    NEXTAUTH_SECRET: { get: async () => jwtSecret } as SecretsStoreSecret,
  } as CloudflareEnv;
  const authorizationHeader = async (userId: string): Promise<string> => {
    const { token } = await signKiloToken({
      userId,
      pepper: null,
      secret: jwtSecret,
      expiresInSeconds: 60 * 60,
    });
    return `Bearer ${token}`;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.disconnectUserAuthorization.mockResolvedValue(undefined);
  });

  it.each([new Headers({ Authorization: 'Bearer invalid' }), new Headers()])(
    'does not run disconnect before user authentication succeeds',
    async headers => {
      const response = await handler.fetch(
        new Request(
          'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/disconnect',
          { method: 'POST', headers }
        ),
        env
      );

      expect(response.status).toBe(401);
      expect(serviceMocks.disconnectUserAuthorization).not.toHaveBeenCalled();
    }
  );

  it('returns a sanitized availability error when JWT secret resolution fails', async () => {
    const unavailableEnv = {
      NEXTAUTH_SECRET: { get: async () => Promise.reject(new Error('secret store unavailable')) },
    } as unknown as CloudflareEnv;
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/disconnect',
        {
          method: 'POST',
          headers: { Authorization: await authorizationHeader('user_1') },
        }
      ),
      unavailableEnv
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'authentication_unavailable' });
    expect(serviceMocks.disconnectUserAuthorization).not.toHaveBeenCalled();
  });

  it('exposes only the authenticated POST disconnect route', async () => {
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/disconnect',
        {
          method: 'POST',
          headers: { Authorization: await authorizationHeader('user_1') },
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ disconnected: true });
    expect(serviceMocks.disconnectUserAuthorization).toHaveBeenCalledWith('user_1');

    const wrongMethod = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/disconnect'
      ),
      env
    );
    expect(wrongMethod.status).toBe(405);

    const unrelated = await handler.fetch(
      new Request('https://git-token-service.kilosessions.ai/getTokenForRepo', { method: 'POST' }),
      env
    );
    expect(unrelated.status).toBe(404);
  });

  it('accepts a local string JWT secret value', async () => {
    const localEnv = { NEXTAUTH_SECRET: jwtSecret } as unknown as CloudflareEnv;
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/disconnect',
        {
          method: 'POST',
          headers: { Authorization: await authorizationHeader('user_1') },
        }
      ),
      localEnv
    );

    expect(response.status).toBe(200);
    expect(serviceMocks.disconnectUserAuthorization).toHaveBeenCalledWith('user_1');
  });

  it('derives the disconnect identity from the verified token instead of the request body', async () => {
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/disconnect',
        {
          method: 'POST',
          headers: { Authorization: await authorizationHeader('user_1') },
          body: JSON.stringify({ kiloUserId: 'user_2' }),
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(serviceMocks.disconnectUserAuthorization).toHaveBeenCalledWith('user_1');
  });

  it('returns sanitized failures from disconnect orchestration', async () => {
    serviceMocks.disconnectUserAuthorization.mockRejectedValueOnce(new Error('ciphertext token'));
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/disconnect',
        {
          method: 'POST',
          headers: { Authorization: await authorizationHeader('user_1') },
        }
      ),
      env
    );

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({ error: 'disconnect_failed' });
  });
});
