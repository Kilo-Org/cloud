import {
  BITBUCKET_REPOSITORY_LIST_AUDIENCE,
  GITHUB_USER_ACCESS_TOKEN_AUDIENCE,
  signKiloToken,
} from '@kilocode/worker-utils';
import { signModernKiloToken } from '@kilocode/worker-utils/kilo-token-policy';
import {
  GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE,
  KILO_API_AUDIENCE,
  KILO_GATEWAY_AUDIENCE,
} from '@kilocode/worker-utils/internal-service-token-audiences';
import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const serviceMocks = vi.hoisted(() => ({
  findManagedInstallationForRepo: vi.fn(),
  findRefreshCandidates: vi.fn(),
  updateAccountLogin: vi.fn(),
  getTokenForRepo: vi.fn(),
  refreshInstallationAccountLoginIfDue: vi.fn(),
  selectUserAuthorization: vi.fn(),
  disconnectUserAuthorization: vi.fn(),
  getUserAccessToken: vi.fn(),
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
    refreshInstallationAccountLoginIfDue = serviceMocks.refreshInstallationAccountLoginIfDue;
  },
}));

vi.mock('./installation-lookup-service.js', () => ({
  InstallationLookupService: class InstallationLookupService {
    findManagedInstallationForRepo = serviceMocks.findManagedInstallationForRepo;
    findRefreshCandidates = serviceMocks.findRefreshCandidates;
    updateAccountLogin = serviceMocks.updateAccountLogin;
  },
}));

vi.mock('./github-user-authorization-service.js', () => ({
  GitHubUserAuthorizationService: class GitHubUserAuthorizationService {
    selectUserAuthorization = serviceMocks.selectUserAuthorization;
    disconnectUserAuthorization = serviceMocks.disconnectUserAuthorization;
    getUserAccessToken = serviceMocks.getUserAccessToken;
  },
}));

vi.mock('./gitlab-lookup-service.js', () => ({
  GitLabLookupService: class GitLabLookupService {},
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

  it('repairs stale login metadata before resolving fenced Cloud Agent auth', async () => {
    const params = {
      githubRepo: 'acme/repo',
      userId: 'user_1',
      orgId: '00000000-0000-4000-8000-000000000001',
      expectedIntegrationId: '00000000-0000-4000-8000-000000000002',
      allowUserAuthorization: true,
    };
    serviceMocks.findManagedInstallationForRepo
      .mockResolvedValueOnce({ success: false, reason: 'integration_mismatch' })
      .mockResolvedValueOnce({
        success: true,
        installationId: '123',
        accountLogin: 'acme',
        githubAppType: 'standard',
        repoName: 'repo',
        permissions: { contents: 'write', pull_requests: 'write' },
      });
    serviceMocks.findRefreshCandidates.mockResolvedValue({
      success: true,
      candidates: [
        {
          integrationId: params.expectedIntegrationId,
          installationId: '123',
          accountLogin: 'old-acme',
          githubAppType: 'standard',
        },
      ],
    });
    serviceMocks.refreshInstallationAccountLoginIfDue.mockResolvedValue('acme');
    serviceMocks.updateAccountLogin.mockResolvedValue(true);
    vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(createService().getCloudAgentAuthForRepo(params)).resolves.toMatchObject({
      success: true,
      source: 'user',
      githubToken: 'user-token',
    });
    expect(serviceMocks.findManagedInstallationForRepo).toHaveBeenCalledTimes(2);
    expect(serviceMocks.findRefreshCandidates).toHaveBeenCalledWith(params);
    expect(serviceMocks.updateAccountLogin).toHaveBeenCalledWith(
      params.expectedIntegrationId,
      'acme'
    );
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
  const authorizationHeader = async (userId: string, audience?: string): Promise<string> => {
    const { token } = await signKiloToken({
      userId,
      pepper: null,
      secret: jwtSecret,
      expiresInSeconds: 60 * 60,
      ...(audience ? { audience } : {}),
    });
    return `Bearer ${token}`;
  };
  const modernAuthorizationHeader = async (userId: string, audience: string): Promise<string> => {
    const { token } = await signModernKiloToken({
      userId,
      secret: jwtSecret,
      expiresInSeconds: 60 * 60,
      audience,
      tokenPurpose: 'internal-service',
      credentialExchange: false,
    });
    return `Bearer ${token}`;
  };
  const rawAuthorizationHeader = (
    aud: unknown,
    claims: { exp?: number; version?: number } = {}
  ): string => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        version: claims.version ?? 3,
        kiloUserId: 'user_1',
        apiTokenPepper: null,
        aud,
        iat: now,
        exp: claims.exp ?? now + 60 * 60,
      })
    ).toString('base64url');
    const token = `${header}.${payload}.${createHmac('sha256', jwtSecret)
      .update(`${header}.${payload}`)
      .digest('base64url')}`;
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

  it('rejects a token issued for the Bitbucket repository-list endpoint', async () => {
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/disconnect',
        {
          method: 'POST',
          headers: {
            Authorization: await authorizationHeader('user_1', BITBUCKET_REPOSITORY_LIST_AUDIENCE),
          },
        }
      ),
      env
    );

    expect(response.status).toBe(401);
    expect(serviceMocks.disconnectUserAuthorization).not.toHaveBeenCalled();
  });

  it('accepts a modern internal-service token for the disconnect audience', async () => {
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/disconnect',
        {
          method: 'POST',
          headers: {
            Authorization: await modernAuthorizationHeader(
              'user_1',
              GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE
            ),
          },
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(serviceMocks.disconnectUserAuthorization).toHaveBeenCalledWith('user_1');
  });

  it('accepts the disconnect audience in a valid unique audience array', async () => {
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/disconnect',
        {
          method: 'POST',
          headers: {
            Authorization: rawAuthorizationHeader([
              KILO_API_AUDIENCE,
              GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE,
            ]),
          },
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(serviceMocks.disconnectUserAuthorization).toHaveBeenCalledWith('user_1');
  });

  it.each([
    KILO_API_AUDIENCE,
    KILO_GATEWAY_AUDIENCE,
    'git-token-service',
    GITHUB_USER_ACCESS_TOKEN_AUDIENCE,
    null,
    '',
    [
      'git-token-service:github-user-authorizations:disconnect',
      'git-token-service:github-user-authorizations:disconnect',
    ],
    ['git-token-service:github-user-authorizations:disconnect', ''],
  ])('rejects a non-matching or malformed disconnect audience %j', async aud => {
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/disconnect',
        { method: 'POST', headers: { Authorization: rawAuthorizationHeader(aud) } }
      ),
      env
    );

    expect(response.status).toBe(401);
    expect(serviceMocks.disconnectUserAuthorization).not.toHaveBeenCalled();
  });

  it.each([
    ['expired', rawAuthorizationHeader(GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE, { exp: 0 })],
    [
      'wrong-version',
      rawAuthorizationHeader(GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE, { version: 2 }),
    ],
    ['bad-signature', 'Bearer invalid'],
  ])('rejects %s tokens before disconnect', async (_name, authorization) => {
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/disconnect',
        { method: 'POST', headers: { Authorization: authorization } }
      ),
      env
    );

    expect(response.status).toBe(401);
    expect(serviceMocks.disconnectUserAuthorization).not.toHaveBeenCalled();
  });

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

describe('fetch user-access-token endpoint', () => {
  const jwtSecret = 'test-secret-that-is-at-least-32-characters';
  const env = {
    NEXTAUTH_SECRET: { get: async () => jwtSecret } as SecretsStoreSecret,
  } as CloudflareEnv;
  const tokenFor = async (userId: string, audience?: string): Promise<string> => {
    const { token } = await signKiloToken({
      userId,
      pepper: null,
      secret: jwtSecret,
      expiresInSeconds: 60 * 60,
      ...(audience ? { audience } : {}),
    });
    return `Bearer ${token}`;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.getUserAccessToken.mockResolvedValue({
      connected: false,
      reason: 'not_connected',
    });
  });

  it.each([new Headers({ Authorization: 'Bearer invalid' }), new Headers()])(
    'does not run getUserAccessToken before user authentication succeeds (%s)',
    async headers => {
      const response = await handler.fetch(
        new Request(
          'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/token',
          { method: 'POST', headers }
        ),
        env
      );

      expect(response.status).toBe(401);
      expect(serviceMocks.getUserAccessToken).not.toHaveBeenCalled();
    }
  );

  it('rejects a generic Kilo token without the user-access-token audience', async () => {
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/token',
        {
          method: 'POST',
          headers: { Authorization: await tokenFor('user_1') },
          body: JSON.stringify({ op: 'fetch' }),
        }
      ),
      env
    );

    expect(response.status).toBe(401);
    expect(serviceMocks.getUserAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a token issued for a different internal audience', async () => {
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/token',
        {
          method: 'POST',
          headers: {
            Authorization: await tokenFor('user_1', BITBUCKET_REPOSITORY_LIST_AUDIENCE),
          },
          body: JSON.stringify({ op: 'fetch' }),
        }
      ),
      env
    );

    expect(response.status).toBe(401);
    expect(serviceMocks.getUserAccessToken).not.toHaveBeenCalled();
  });

  it('rejects a token issued for the disconnect endpoint', async () => {
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/token',
        {
          method: 'POST',
          headers: {
            Authorization: await tokenFor('user_1', GITHUB_USER_AUTHORIZATION_DISCONNECT_AUDIENCE),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ op: 'fetch' }),
        }
      ),
      env
    );

    expect(response.status).toBe(401);
    expect(serviceMocks.getUserAccessToken).not.toHaveBeenCalled();
  });

  it('derives the actor from the verified JWT and ignores a body user id for fetch', async () => {
    serviceMocks.getUserAccessToken.mockResolvedValueOnce({
      connected: true,
      token: 'plaintext-user-token',
      expiresAtEpochMs: 1_700_000_000_000,
      githubLogin: 'octocat',
      authorizationId: 'authorization_1',
      credentialVersion: 2,
    });

    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/token',
        {
          method: 'POST',
          headers: {
            Authorization: await tokenFor('user_1', GITHUB_USER_ACCESS_TOKEN_AUDIENCE),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ op: 'fetch', userId: 'user_2' }),
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      connected: true,
      token: 'plaintext-user-token',
      expiresAtEpochMs: 1_700_000_000_000,
      githubLogin: 'octocat',
      authorizationId: 'authorization_1',
      credentialVersion: 2,
    });
    expect(serviceMocks.getUserAccessToken).toHaveBeenCalledWith('user_1', { op: 'fetch' });
  });

  it('returns 400 when the request body is not valid JSON', async () => {
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/token',
        {
          method: 'POST',
          headers: {
            Authorization: await tokenFor('user_1', GITHUB_USER_ACCESS_TOKEN_AUDIENCE),
            'Content-Type': 'application/json',
          },
          body: '{not-json',
        }
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.getUserAccessToken).not.toHaveBeenCalled();
  });

  it('rejects malformed discriminated union bodies', async () => {
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/token',
        {
          method: 'POST',
          headers: {
            Authorization: await tokenFor('user_1', GITHUB_USER_ACCESS_TOKEN_AUDIENCE),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ op: 'rotate' }),
        }
      ),
      env
    );

    expect(response.status).toBe(400);
    expect(serviceMocks.getUserAccessToken).not.toHaveBeenCalled();
  });

  it('rejects non-POST methods', async () => {
    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/token',
        {
          method: 'GET',
          headers: {
            Authorization: await tokenFor('user_1', GITHUB_USER_ACCESS_TOKEN_AUDIENCE),
          },
        }
      ),
      env
    );

    expect(response.status).toBe(405);
    expect(serviceMocks.getUserAccessToken).not.toHaveBeenCalled();
  });

  it('returns 404 for unrelated paths even with the user-access-token audience', async () => {
    const response = await handler.fetch(
      new Request('https://git-token-service.kilosessions.ai/getTokenForRepo', {
        method: 'POST',
        headers: {
          Authorization: await tokenFor('user_1', GITHUB_USER_ACCESS_TOKEN_AUDIENCE),
        },
      }),
      env
    );

    expect(response.status).toBe(404);
    expect(serviceMocks.getUserAccessToken).not.toHaveBeenCalled();
  });

  it('forwards rotate op and revokes generation via service when matching', async () => {
    serviceMocks.getUserAccessToken.mockResolvedValueOnce({
      connected: false,
      reason: 'revoked',
    });

    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/token',
        {
          method: 'POST',
          headers: {
            Authorization: await tokenFor('user_1', GITHUB_USER_ACCESS_TOKEN_AUDIENCE),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            op: 'rotate',
            staleAuthorizationId: 'authorization_1',
            staleCredentialVersion: 1,
          }),
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ connected: false, reason: 'revoked' });
    expect(serviceMocks.getUserAccessToken).toHaveBeenCalledWith('user_1', {
      op: 'rotate',
      staleAuthorizationId: 'authorization_1',
      staleCredentialVersion: 1,
    });
  });

  it('forwards reportRejected op and reports the matching credential version as revoked', async () => {
    serviceMocks.getUserAccessToken.mockResolvedValueOnce({
      connected: false,
      reason: 'revoked',
    });

    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/token',
        {
          method: 'POST',
          headers: {
            Authorization: await tokenFor('user_1', GITHUB_USER_ACCESS_TOKEN_AUDIENCE),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            op: 'reportRejected',
            authorizationId: 'authorization_1',
            credentialVersion: 3,
          }),
        }
      ),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ connected: false, reason: 'revoked' });
    expect(serviceMocks.getUserAccessToken).toHaveBeenCalledWith('user_1', {
      op: 'reportRejected',
      authorizationId: 'authorization_1',
      credentialVersion: 3,
    });
  });

  it('maps a temporarily-unavailable service failure to a 503 response', async () => {
    serviceMocks.getUserAccessToken.mockRejectedValueOnce(
      Object.assign(new Error('temporarily_unavailable'), {})
    );

    const response = await handler.fetch(
      new Request(
        'https://git-token-service.kilosessions.ai/internal/github-user-authorizations/token',
        {
          method: 'POST',
          headers: {
            Authorization: await tokenFor('user_1', GITHUB_USER_ACCESS_TOKEN_AUDIENCE),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ op: 'fetch' }),
        }
      ),
      env
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'temporarily_unavailable' });
  });
});
