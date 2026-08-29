import { signKiloToken } from '@kilocode/worker-utils';
import * as dbClient from '@kilocode/db/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as GitLabCredentialBrokerHandlerModule from './gitlab-credential-broker-handler.js';
import type * as GitLabLookupServiceModule from './gitlab-lookup-service.js';
import type * as InteractiveReviewHandlerModule from './interactive-review-handler.js';
import type * as InstallationLookupServiceModule from './installation-lookup-service.js';
import { GitHubSessionCapabilityCodec } from './github-session-capability.js';
import type {
  FindInstallationParams,
  ManagedInstallationLookupSuccess,
} from './installation-lookup-service.js';

const serviceMocks = vi.hoisted(() => ({
  findInstallationId: vi.fn(),
  findManagedInstallationForRepo: vi.fn(),
  findRefreshCandidates: vi.fn(),
  updateAccountLogin: vi.fn(),
  getToken: vi.fn(),
  getTokenForRepo: vi.fn(),
  refreshInstallationAccountLoginIfDue: vi.fn(),
  selectUserAuthorization: vi.fn(),
  findGitLabIntegration: vi.fn(),
  findAuthorizedGitLabIntegrations: vi.fn(),
  getGitLabToken: vi.fn(),
  resolveGitLabCredential: vi.fn(),
  hasGitLabProjectCredentialCandidates: vi.fn(),
  listBitbucketRepositories: vi.fn(),
  resolveBitbucketToken: vi.fn(),
  resolveBitbucketCapabilitySubject: vi.fn(),
  handleBitbucketInteractiveReview: vi.fn(),
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
    getToken = serviceMocks.getToken;
    getTokenForRepo = serviceMocks.getTokenForRepo;
    refreshInstallationAccountLoginIfDue = serviceMocks.refreshInstallationAccountLoginIfDue;
  },
}));

vi.mock('./installation-lookup-service.js', () => ({
  InstallationLookupService: class InstallationLookupService {
    findInstallationId = serviceMocks.findInstallationId;
    findManagedInstallationForRepo = serviceMocks.findManagedInstallationForRepo;
    findRefreshCandidates = serviceMocks.findRefreshCandidates;
    updateAccountLogin = serviceMocks.updateAccountLogin;
  },
}));

vi.mock('./github-user-authorization-service.js', () => ({
  GitHubUserAuthorizationService: class GitHubUserAuthorizationService {
    selectUserAuthorization = serviceMocks.selectUserAuthorization;
  },
}));

vi.mock('./gitlab-lookup-service.js', async importOriginal => {
  const actual = await importOriginal<typeof GitLabLookupServiceModule>();
  return {
    ...actual,
    GitLabLookupService: class GitLabLookupService {
      findGitLabIntegration = serviceMocks.findGitLabIntegration;
      findAuthorizedGitLabIntegrations = serviceMocks.findAuthorizedGitLabIntegrations;
    },
  };
});

vi.mock('./gitlab-credential-broker-handler.js', async importOriginal => {
  const actual = await importOriginal<typeof GitLabCredentialBrokerHandlerModule>();
  return {
    ...actual,
    createGitLabCredentialBroker: () => ({
      resolveCredential: serviceMocks.resolveGitLabCredential,
      hasProjectCredentialCandidates: serviceMocks.hasGitLabProjectCredentialCandidates,
    }),
    handleGitLabCredentialBrokerRequest: async (
      _env: CloudflareEnv,
      actor: { userId: string; orgId?: string },
      selector: { credential: 'integration' | 'project-exact'; integrationId: string }
    ) => {
      const result = await serviceMocks.resolveGitLabCredential(actor, selector);
      if (result.status !== 'available') return result;
      return {
        status: 'available',
        token: result.token,
        instanceUrl: result.instanceUrl,
        glabIsOAuth2: result.glabIsOAuth2,
      };
    },
  };
});

vi.mock('./bitbucket-runtime-token-resolver.js', () => ({
  listBitbucketRepositories: serviceMocks.listBitbucketRepositories,
  resolveBitbucketToken: serviceMocks.resolveBitbucketToken,
  resolveBitbucketCapabilitySubject: serviceMocks.resolveBitbucketCapabilitySubject,
}));

vi.mock('./interactive-review-handler.js', async importOriginal => {
  const actual = await importOriginal<typeof InteractiveReviewHandlerModule>();
  return {
    ...actual,
    handleBitbucketInteractiveReview: serviceMocks.handleBitbucketInteractiveReview,
  };
});

import gitTokenServiceWorker, { GitTokenRPCEntrypoint } from './index.js';

beforeEach(() => {
  serviceMocks.hasGitLabProjectCredentialCandidates.mockReset().mockResolvedValue(false);
  serviceMocks.findAuthorizedGitLabIntegrations.mockReset().mockImplementation(async actor => {
    const integration = await serviceMocks.findGitLabIntegration(actor);
    return integration.success ? { success: true, integrations: [integration] } : integration;
  });
  serviceMocks.resolveGitLabCredential.mockReset().mockImplementation(async (actor, selector) => {
    const latestIntegrationLookup = serviceMocks.findGitLabIntegration.mock.results.at(-1)?.value;
    const latestAuthorizedLookup =
      serviceMocks.findAuthorizedGitLabIntegrations.mock.results.at(-1)?.value;
    let integration = latestIntegrationLookup ? await latestIntegrationLookup : undefined;
    if (!integration?.success && latestAuthorizedLookup) {
      const authorized = await latestAuthorizedLookup;
      integration = authorized.success
        ? authorized.integrations.find(
            (candidate: { integrationId: string }) =>
              candidate.integrationId === selector.integrationId
          )
        : undefined;
    }
    if (!integration?.success && !integration?.integrationId) {
      integration = await serviceMocks.findGitLabIntegration(actor, selector.integrationId);
    }
    if (!integration?.success && !integration?.integrationId) {
      return { status: 'not_connected' };
    }
    const metadata = integration.metadata ?? {};
    const instanceUrl = metadata.gitlab_instance_url ?? 'https://gitlab.com';
    if (selector.credential === 'project-exact') {
      const token = metadata.project_tokens?.[selector.projectId]?.token;
      return token
        ? {
            status: 'available',
            token,
            instanceUrl,
            glabIsOAuth2: false,
            integrationId: integration.integrationId,
            source: { type: 'project', projectId: selector.projectId },
          }
        : { status: 'reconnect_required' };
    }
    const token = await serviceMocks.getGitLabToken(selector.integrationId, metadata, actor);
    if (!token.success) {
      return {
        status:
          token.reason === 'token_refresh_failed'
            ? 'temporarily_unavailable'
            : 'reconnect_required',
      };
    }
    return {
      status: 'available',
      token: token.token,
      instanceUrl: token.instanceUrl,
      glabIsOAuth2:
        integration.integrationType === 'oauth' ||
        (integration.integrationType !== 'pat' && metadata.auth_type === 'oauth'),
      integrationId: integration.integrationId,
      source: { type: 'integration' },
    };
  });
});

describe('Bitbucket interactive HTTP boundary', () => {
  const secret = 'test-secret-that-is-at-least-32-characters';
  const audience = 'git-token-service:bitbucket-interactive-review';
  const organizationId = '123e4567-e89b-12d3-a456-426614174030';
  const input = {
    integrationId: '123e4567-e89b-12d3-a456-426614174033',
    workspaceUuid: '123e4567-e89b-12d3-a456-426614174031',
    workspaceSlug: 'acme',
    repositoryUuid: '123e4567-e89b-12d3-a456-426614174032',
    repositoryFullName: 'acme/widgets',
    request: {
      operation: 'createComment',
      params: { path: { workspace: 'acme', repo_slug: 'widgets', pull_request_id: 7 } },
      body: { content: { raw: '' } },
    },
  };
  const env = { NEXTAUTH_SECRET: secret } as CloudflareEnv;
  async function send(
    options: {
      audience?: string | null;
      personal?: boolean;
      body?: string;
      path?: string;
      method?: string;
      headers?: Record<string, string>;
    } = {}
  ) {
    const { token } = await signKiloToken({
      userId: 'oauth/member',
      pepper: null,
      secret,
      expiresInSeconds: 60,
      audience: options.audience === null ? undefined : (options.audience ?? audience),
      extra: options.personal ? undefined : { organizationId },
    });
    return gitTokenServiceWorker.fetch(
      new Request(
        `https://service.test${options.path ?? '/internal/bitbucket/interactive-review'}`,
        {
          method: options.method ?? 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...options.headers,
          },
          ...(options.method === 'GET' ? {} : { body: options.body ?? JSON.stringify(input) }),
        }
      ),
      env
    );
  }
  beforeEach(() => {
    serviceMocks.handleBitbucketInteractiveReview
      .mockReset()
      .mockImplementation(async (_env, actor) => ({
        success: true,
        result: { status: 201, data: { id: 91 } },
        metadata: {
          actorUserId: actor.userId,
          organizationId: actor.orgId,
          integrationId: input.integrationId,
          instanceUrl: 'https://bitbucket.org',
          providerActor: {
            credentialKind: 'bitbucketWorkspaceToken',
            workspaceUuid: input.workspaceUuid,
            workspaceSlug: input.workspaceSlug,
          },
          grants: { scopes: ['pullrequest'] },
        },
      }));
  });

  it('dispatches with verified claims and retains allowlisted metadata in a no-store response', async () => {
    const response = await send();
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      result: { status: 201, data: { id: 91 } },
      metadata: { actorUserId: 'oauth/member', organizationId },
    });
  });

  it.each([
    [{ method: 'GET' }, 405],
    [{ audience: null }, 401],
    [{ audience: 'git-token-service:bitbucket-repositories' }, 401],
    [{ personal: true }, 403],
    [{ body: '{' }, 400],
    [{ headers: { 'Content-Type': 'text/plain' } }, 400],
    [{ body: JSON.stringify({ ...input, actorUserId: 'attacker' }) }, 400],
    [{ body: JSON.stringify({ ...input, metadata: { actorUserId: 'attacker' } }) }, 400],
  ] as const)('does not cache or dispatch invalid requests %#', async (options, status) => {
    const response = await send(options);
    expect(response.status).toBe(status);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(serviceMocks.handleBitbucketInteractiveReview).not.toHaveBeenCalled();
  });

  it.each([256_000, 256_001])(
    'enforces the separate streamed byte limit at %i bytes',
    async bytes => {
      const raw = 'x'.repeat(bytes - new TextEncoder().encode(JSON.stringify(input)).byteLength);
      const response = await send({
        body: JSON.stringify({
          ...input,
          request: { ...input.request, body: { content: { raw } } },
        }),
      });
      expect(response.status).toBe(bytes === 256_000 ? 200 : 413);
      expect(response.headers.get('Cache-Control')).toBe('no-store');
      await expect(response.json()).resolves.toMatchObject(
        bytes === 256_000 ? { success: true } : { success: false, reason: 'request_too_large' }
      );
    }
  );

  it('rejects oversized declared length before handler dispatch', async () => {
    const response = await send({ headers: { 'Content-Length': '256001' } });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ success: false, reason: 'request_too_large' });
    expect(serviceMocks.handleBitbucketInteractiveReview).not.toHaveBeenCalled();
  });

  it.each([
    ['/internal/gitlab/credentials', 'git-token-service:gitlab-credentials'],
    ['/internal/github-user-authorizations/token', 'git-token-service:github-user-access-token'],
    [
      '/internal/bitbucket/code-review/pull-request',
      'git-token-service:bitbucket-code-review:pull-request',
    ],
    [
      '/internal/bitbucket/code-review/webhooks/ensure',
      'git-token-service:bitbucket-code-review:webhook-ensure',
    ],
    [
      '/internal/bitbucket/code-review/webhooks/delete',
      'git-token-service:bitbucket-code-review:webhook-delete',
    ],
  ])('retains the 16,000-byte limit on %s', async (path, audience) => {
    const response = await send({ path, audience, body: '{}'.padEnd(16_001, ' ') });
    expect(response.status).toBe(400);
  });

  it('does not expose sibling paths', async () => {
    expect((await send({ path: '/internal/bitbucket/interactive-review/other' })).status).toBe(404);
  });

  it('sanitizes handler failure and prevents caching', async () => {
    serviceMocks.handleBitbucketInteractiveReview.mockRejectedValue(new Error('provider-secret'));
    const response = await send();
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      success: false,
      reason: 'temporarily_unavailable',
    });
  });

  it('prevents caching when authentication is unavailable', async () => {
    const response = await gitTokenServiceWorker.fetch(
      new Request('https://service.test/internal/bitbucket/interactive-review', {
        method: 'POST',
        headers: { Authorization: 'Bearer assertion' },
      }),
      { NEXTAUTH_SECRET: '' } as CloudflareEnv
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'authentication_unavailable' });
  });
});

describe('Bitbucket repository-list HTTP authorization', () => {
  const jwtSecret = 'test-secret-that-is-at-least-32-characters';
  const env = { NEXTAUTH_SECRET: jwtSecret } as CloudflareEnv;

  beforeEach(() => {
    serviceMocks.listBitbucketRepositories.mockReset().mockResolvedValue({
      status: 'available',
      repositories: [],
    });
  });

  it('derives the owner from a purpose-bound token instead of request input', async () => {
    const { token } = await signKiloToken({
      userId: 'member-1',
      pepper: null,
      secret: jwtSecret,
      expiresInSeconds: 5 * 60,
      audience: 'git-token-service:bitbucket-repositories',
      extra: { organizationId: '123e4567-e89b-12d3-a456-426614174030' },
    });
    const response = await gitTokenServiceWorker.fetch(
      new Request('https://git-token-service.test/internal/bitbucket/repositories', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ orgId: '123e4567-e89b-12d3-a456-426614174099' }),
      }),
      env
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'available', repositories: [] });
    expect(serviceMocks.listBitbucketRepositories).toHaveBeenCalledWith(expect.anything(), {
      userId: 'member-1',
      orgId: '123e4567-e89b-12d3-a456-426614174030',
    });
  });

  it('requires an organization claim before repository lookup', async () => {
    const { token } = await signKiloToken({
      userId: 'member-1',
      pepper: null,
      secret: jwtSecret,
      expiresInSeconds: 5 * 60,
      audience: 'git-token-service:bitbucket-repositories',
    });
    const response = await gitTokenServiceWorker.fetch(
      new Request('https://git-token-service.test/internal/bitbucket/repositories', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
      env
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: 'organization_required' });
    expect(serviceMocks.listBitbucketRepositories).not.toHaveBeenCalled();
  });

  it('rejects a generic Kilo token without the repository-list audience', async () => {
    const { token } = await signKiloToken({
      userId: 'member-1',
      pepper: null,
      secret: jwtSecret,
      expiresInSeconds: 5 * 60,
    });
    const response = await gitTokenServiceWorker.fetch(
      new Request('https://git-token-service.test/internal/bitbucket/repositories', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
      env
    );

    expect(response.status).toBe(401);
    expect(serviceMocks.listBitbucketRepositories).not.toHaveBeenCalled();
  });
});

describe('GitLab credential broker HTTP authorization', () => {
  const jwtSecret = 'test-secret-that-is-at-least-32-characters';
  const integrationId = '123e4567-e89b-12d3-a456-426614174012';

  beforeEach(() => {
    serviceMocks.findGitLabIntegration.mockReset().mockResolvedValue({
      success: true,
      integrationId,
      integrationType: 'pat',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: {
        access_token: 'legacy-gitlab-token',
        auth_type: 'pat',
        gitlab_instance_url: 'https://gitlab.example.com',
      },
    });
    serviceMocks.getGitLabToken.mockReset().mockResolvedValue({
      success: true,
      token: 'legacy-gitlab-token',
      instanceUrl: 'https://gitlab.example.com',
    });
  });

  it('derives the actor from a purpose-bound JWT and disables response caching', async () => {
    const { token } = await signKiloToken({
      userId: 'user-1',
      pepper: null,
      secret: jwtSecret,
      expiresInSeconds: 5 * 60,
      audience: 'git-token-service:gitlab-credentials',
    });
    const response = await gitTokenServiceWorker.fetch(
      new Request('https://git-token-service.test/internal/gitlab/credentials', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ credential: 'integration', integrationId }),
      }),
      {
        NEXTAUTH_SECRET: jwtSecret,
      } as unknown as CloudflareEnv
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({
      status: 'available',
      token: 'legacy-gitlab-token',
      instanceUrl: 'https://gitlab.example.com',
      glabIsOAuth2: false,
    });
    expect(serviceMocks.findGitLabIntegration).toHaveBeenCalledWith(
      { userId: 'user-1' },
      integrationId
    );
  });

  it('rejects a token without the GitLab broker audience', async () => {
    const { token } = await signKiloToken({
      userId: 'user-1',
      pepper: null,
      secret: jwtSecret,
      expiresInSeconds: 5 * 60,
    });
    const response = await gitTokenServiceWorker.fetch(
      new Request('https://git-token-service.test/internal/gitlab/credentials', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ credential: 'integration', integrationId }),
      }),
      {
        NEXTAUTH_SECRET: jwtSecret,
      } as unknown as CloudflareEnv
    );

    expect(response.status).toBe(401);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(serviceMocks.findGitLabIntegration).not.toHaveBeenCalled();
  });
});

function createService(): GitTokenRPCEntrypoint {
  return new GitTokenRPCEntrypoint(
    {} as ExecutionContext,
    {
      GITHUB_APP_SLUG: 'kiloconnect',
      GITHUB_APP_BOT_USER_ID: '240665456',
      SCM_SESSION_CAPABILITY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    } as unknown as CloudflareEnv
  );
}

describe('GitTokenRPCEntrypoint Bitbucket session capability', () => {
  const subject = {
    integrationId: '123e4567-e89b-12d3-a456-426614174022',
    workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
    workspaceSlug: 'acme',
    repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
    repositoryFullName: 'acme/widgets',
    token: 'ATCT-runtime-token',
  };
  const issueParams = {
    userId: 'user-1',
    orgId: '123e4567-e89b-12d3-a456-426614174030',
    outboundContainerId: 'outbound-container-1',
    workspaceUuid: subject.workspaceUuid,
    repositoryUuid: subject.repositoryUuid,
    repositoryUrl: 'https://bitbucket.org/acme/widgets.git',
  };

  beforeEach(() => {
    serviceMocks.resolveBitbucketCapabilitySubject
      .mockReset()
      .mockResolvedValue({ success: true, subject });
  });

  async function issueCapability(): Promise<string> {
    const result = await createService().issueBitbucketSessionCapability(issueParams);
    if (!result.success) throw new Error(`issue failed: ${result.reason}`);
    return result.capability;
  }

  it.each([
    ['legacy request', {}],
    ['matching pin', { expectedIntegrationId: subject.integrationId }],
    // The RPC projection must trust the resolver, not echo a caller's claimed pin.
    ['different caller pin', { expectedIntegrationId: '123e4567-e89b-12d3-a456-426614174099' }],
  ] as const)(
    'returns the capability, canonical URL, and resolved integration for %s',
    async (_name, pin) => {
      const result = await createService().issueBitbucketSessionCapability({
        ...issueParams,
        ...pin,
      });
      expect(result).toEqual({
        success: true,
        capability: expect.stringMatching(/^kbb1\./),
        gitUrl: 'https://bitbucket.org/acme/widgets.git',
        integrationId: subject.integrationId,
      });
      if (!result.success) throw new Error(`issue failed: ${result.reason}`);
      expect(result.capability).not.toContain(subject.token);
      const { BitbucketSessionCapabilityCodec } = await import('./bitbucket-session-capability.js');
      const claims = new BitbucketSessionCapabilityCodec(
        Buffer.alloc(32, 7).toString('base64')
      ).decode(result.capability);
      expect(claims).toMatchObject({
        integrationId: subject.integrationId,
        workspaceUuid: subject.workspaceUuid,
        repositoryUuid: subject.repositoryUuid,
        repositoryFullName: 'acme/widgets',
        outboundContainerId: 'outbound-container-1',
      });
    }
  );

  it.each([
    'invalid_request',
    'not_connected',
    'reconnect_required',
    'temporarily_unavailable',
    'insufficient_permissions',
    'integration_mismatch',
    'workspace_mismatch',
    'repository_not_found',
    'repository_mismatch',
  ])('preserves issue failure %s without exposing identity or credentials', async reason => {
    serviceMocks.resolveBitbucketCapabilitySubject
      .mockReset()
      .mockResolvedValue({ success: false, reason });
    await expect(
      createService().issueBitbucketSessionCapability({
        ...issueParams,
        expectedIntegrationId: subject.integrationId,
      })
    ).resolves.toEqual({ success: false, reason });
  });

  it('exposes no resolved identity when capability configuration fails', async () => {
    const service = new GitTokenRPCEntrypoint({} as ExecutionContext, {} as CloudflareEnv);
    await expect(service.issueBitbucketSessionCapability(issueParams)).resolves.toEqual({
      success: false,
      reason: 'capability_configuration_error',
    });
  });

  it('redeems a valid capability into an injected Basic auth header', async () => {
    const capability = await issueCapability();
    await expect(
      createService().redeemBitbucketSessionCapability({
        capability,
        outboundContainerId: 'outbound-container-1',
        requestMethod: 'POST',
        requestUrl: 'https://bitbucket.org/acme/widgets.git/git-upload-pack',
      })
    ).resolves.toEqual({
      success: true,
      headers: {
        authorization: `Basic ${Buffer.from('x-token-auth:ATCT-runtime-token').toString('base64')}`,
      },
    });
  });

  it('rejects redemption from a different container', async () => {
    const capability = await issueCapability();
    await expect(
      createService().redeemBitbucketSessionCapability({
        capability,
        outboundContainerId: 'other-container',
        requestMethod: 'POST',
        requestUrl: 'https://bitbucket.org/acme/widgets.git/git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'container_mismatch' });
  });

  it('rejects redemption for a different repository', async () => {
    const capability = await issueCapability();
    await expect(
      createService().redeemBitbucketSessionCapability({
        capability,
        outboundContainerId: 'outbound-container-1',
        requestMethod: 'POST',
        requestUrl: 'https://bitbucket.org/acme/other.git/git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'repository_mismatch' });
  });

  it('rejects redemption when the token was rotated after issue', async () => {
    const capability = await issueCapability();
    serviceMocks.resolveBitbucketCapabilitySubject
      .mockReset()
      .mockResolvedValue({ success: true, subject: { ...subject, token: 'ATCT-rotated' } });
    await expect(
      createService().redeemBitbucketSessionCapability({
        capability,
        outboundContainerId: 'outbound-container-1',
        requestMethod: 'POST',
        requestUrl: 'https://bitbucket.org/acme/widgets.git/git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'source_unavailable' });
  });

  it('rejects redemption when the integration changes without token rotation', async () => {
    const capability = await issueCapability();
    serviceMocks.resolveBitbucketCapabilitySubject.mockResolvedValue({
      success: true,
      subject: { ...subject, integrationId: '123e4567-e89b-12d3-a456-426614174099' },
    });
    await expect(
      createService().redeemBitbucketSessionCapability({
        capability,
        outboundContainerId: 'outbound-container-1',
        requestMethod: 'POST',
        requestUrl: 'https://bitbucket.org/acme/widgets.git/git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'source_unavailable' });
  });

  it.each([
    // Single-encoded traversal is caught by the raw check.
    ['https://bitbucket.org/acme/widgets.git/%2e%2e/git-upload-pack'],
    // Nested/double-encoded traversal survives the raw check and must be caught
    // by the iterative-decode recheck (mirrors the GitLab %252e%252e%252f case).
    ['https://bitbucket.org/acme/widgets.git/%252e%252e%252facme/other.git/git-upload-pack'],
    ['https://bitbucket.org/acme/widgets.git/objects/..%252f..%252fother/git-upload-pack'],
  ] as const)('rejects percent-encoded path traversal %s', async requestUrl => {
    const capability = await issueCapability();
    await expect(
      createService().redeemBitbucketSessionCapability({
        capability,
        outboundContainerId: 'outbound-container-1',
        requestMethod: 'POST',
        requestUrl,
      })
    ).resolves.toEqual({ success: false, reason: 'invalid_upstream_url' });
  });
});

describe('GitTokenRPCEntrypoint Bitbucket runtime authorization', () => {
  const integrationId = '123e4567-e89b-12d3-a456-426614174022';
  const params = {
    userId: 'user-1',
    orgId: '123e4567-e89b-12d3-a456-426614174030',
    workspaceUuid: '123e4567-e89b-12d3-a456-426614174020',
    repositoryUuid: '123e4567-e89b-12d3-a456-426614174021',
    repositoryUrl: 'https://bitbucket.org/acme/widgets.git',
  };

  it('requires an organization before invoking the reachable V1 resolver', async () => {
    serviceMocks.resolveBitbucketToken.mockReset();

    await expect(
      createService().getBitbucketToken({ ...params, orgId: undefined })
    ).resolves.toEqual({ success: false, reason: 'invalid_request' });
    expect(serviceMocks.resolveBitbucketToken).not.toHaveBeenCalled();
  });

  it.each([
    ['legacy request', {}],
    ['matching pin', { expectedIntegrationId: integrationId }],
    // The resolver owns authorization; this projection must never echo the request pin.
    ['different caller pin', { expectedIntegrationId: '123e4567-e89b-12d3-a456-426614174099' }],
  ] as const)('returns only the token and resolved integration for %s', async (_name, pin) => {
    serviceMocks.resolveBitbucketToken.mockReset().mockResolvedValue({
      success: true,
      token: 'ATCT-runtime-token',
      integrationId,
      credentialId: 'must-not-cross-rpc',
      credentialVersion: 7,
    });

    await expect(createService().getBitbucketToken({ ...params, ...pin })).resolves.toEqual({
      success: true,
      token: 'ATCT-runtime-token',
      integrationId,
    });
    expect(serviceMocks.resolveBitbucketToken).toHaveBeenCalledWith(expect.anything(), {
      ...params,
      ...pin,
    });
  });

  it.each([
    'invalid_request',
    'not_connected',
    'reconnect_required',
    'temporarily_unavailable',
    'insufficient_permissions',
    'integration_mismatch',
    'workspace_mismatch',
    'repository_not_found',
    'repository_mismatch',
  ])('preserves token failure %s without exposing identity or credentials', async reason => {
    serviceMocks.resolveBitbucketToken.mockReset().mockResolvedValue({ success: false, reason });
    await expect(
      createService().getBitbucketToken({ ...params, expectedIntegrationId: integrationId })
    ).resolves.toEqual({ success: false, reason });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GitTokenRPCEntrypoint.getTokenForRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    undefined,
    '00000000-0000-4000-8000-000000000002',
    '00000000-0000-4000-8000-000000000099',
  ])(
    'returns a scoped token and the resolved identity rather than the caller pin %s',
    async expectedIntegrationId => {
      serviceMocks.findInstallationId.mockResolvedValue({
        success: true,
        integrationId: '00000000-0000-4000-8000-000000000002',
        integrationOwner: { type: 'user', id: 'user-1' },
        installationId: '123',
        accountLogin: 'old-owner',
        githubAppType: 'lite',
      });
      serviceMocks.getTokenForRepo.mockResolvedValue('scoped-token');
      serviceMocks.getToken.mockResolvedValue('installation-wide-token');

      const result = await createService().getTokenForRepo({
        githubRepo: 'renamed-owner/repository',
        userId: 'user-1',
        expectedIntegrationId,
      });

      expect(result).toEqual({
        success: true,
        token: 'scoped-token',
        integrationId: '00000000-0000-4000-8000-000000000002',
        integrationOwner: { type: 'user', id: 'user-1' },
        installationId: '123',
        accountLogin: 'old-owner',
        appType: 'lite',
      });
      expect(serviceMocks.getTokenForRepo).toHaveBeenCalledWith('123', 'repository', 'lite');
      expect(serviceMocks.getToken).not.toHaveBeenCalled();
    }
  );

  it('repairs stale login metadata after a lookup miss before minting a token', async () => {
    serviceMocks.findInstallationId
      .mockResolvedValueOnce({ success: false, reason: 'no_installation_found' })
      .mockResolvedValueOnce({
        success: true,
        integrationId: 'integration-1',
        integrationOwner: { type: 'user', id: 'user-1' },
        installationId: '123',
        accountLogin: 'renamed-owner',
        githubAppType: 'standard',
      });
    serviceMocks.findRefreshCandidates.mockResolvedValue({
      success: true,
      candidates: [
        {
          integrationId: 'integration-1',
          installationId: '123',
          accountLogin: 'old-owner',
          githubAppType: 'standard',
        },
      ],
    });
    serviceMocks.updateAccountLogin.mockResolvedValue(true);
    serviceMocks.refreshInstallationAccountLoginIfDue.mockResolvedValue('renamed-owner');
    serviceMocks.getTokenForRepo.mockResolvedValue('scoped-token');
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await createService().getTokenForRepo({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toMatchObject({
      success: true,
      token: 'scoped-token',
      integrationId: 'integration-1',
    });
    expect(serviceMocks.updateAccountLogin).toHaveBeenCalledWith('integration-1', 'renamed-owner');
    expect(consoleLog).toHaveBeenCalledWith(
      JSON.stringify({
        message: 'Repaired GitHub installation account login after token lookup miss',
        integrationId: 'integration-1',
        installationId: '123',
        appType: 'standard',
      })
    );
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('old-owner');
    expect(JSON.stringify(consoleLog.mock.calls)).not.toContain('renamed-owner');
    expect(serviceMocks.findInstallationId).toHaveBeenCalledTimes(2);
    expect(serviceMocks.getTokenForRepo).toHaveBeenCalledWith('123', 'repository', 'standard');
  });

  it('warns instead of reporting success when a repaired integration no longer exists', async () => {
    serviceMocks.findInstallationId.mockResolvedValue({
      success: false,
      reason: 'no_installation_found',
    });
    serviceMocks.findRefreshCandidates.mockResolvedValue({
      success: true,
      candidates: [
        {
          integrationId: 'integration-1',
          installationId: '123',
          accountLogin: 'old-owner',
          githubAppType: 'standard',
        },
      ],
    });
    serviceMocks.updateAccountLogin.mockResolvedValue(false);
    serviceMocks.refreshInstallationAccountLoginIfDue.mockResolvedValue('renamed-owner');
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const result = await createService().getTokenForRepo({
      githubRepo: 'renamed-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'no_installation_found' });
    expect(consoleLog).not.toHaveBeenCalled();
    expect(consoleWarn).toHaveBeenCalledWith(
      JSON.stringify({
        message: 'GitHub installation login repair found no integration row to update',
        integrationId: 'integration-1',
        installationId: '123',
        appType: 'standard',
      })
    );
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('old-owner');
    expect(JSON.stringify(consoleWarn.mock.calls)).not.toContain('renamed-owner');
  });

  it('does not mint when refreshed metadata identifies a different repository owner', async () => {
    serviceMocks.findInstallationId.mockResolvedValue({
      success: false,
      reason: 'no_installation_found',
    });
    serviceMocks.findRefreshCandidates.mockResolvedValue({
      success: true,
      candidates: [
        {
          integrationId: 'integration-1',
          installationId: '123',
          accountLogin: 'old-owner',
          githubAppType: 'standard',
        },
      ],
    });
    serviceMocks.updateAccountLogin.mockResolvedValue(true);
    serviceMocks.refreshInstallationAccountLoginIfDue.mockResolvedValue('different-owner');
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = await createService().getTokenForRepo({
      githubRepo: 'requested-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'no_installation_found' });
    expect(serviceMocks.updateAccountLogin).toHaveBeenCalledWith(
      'integration-1',
      'different-owner'
    );
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('fails closed without metadata repair when exact owner selection is ambiguous', async () => {
    serviceMocks.findInstallationId.mockResolvedValue({
      success: false,
      reason: 'ambiguous_installation',
    });

    const result = await createService().getTokenForRepo({
      githubRepo: 'requested-owner/repository',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'no_installation_found' });
    expect(serviceMocks.findRefreshCandidates).not.toHaveBeenCalled();
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('does not mint a token for an invalid repository path', async () => {
    serviceMocks.findInstallationId.mockResolvedValue({
      success: false,
      reason: 'invalid_repo_format',
    });

    const result = await createService().getTokenForRepo({
      githubRepo: 'owner/repository/extra',
      userId: 'user-1',
    });

    expect(result).toEqual({ success: false, reason: 'invalid_repo_format' });
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('does not fall back to an installation-wide token when scoped minting fails', async () => {
    serviceMocks.findInstallationId.mockResolvedValue({
      success: true,
      integrationId: '00000000-0000-4000-8000-000000000002',
      integrationOwner: { type: 'user', id: 'user_1' },
      installationId: '123',
      accountLogin: 'old-owner',
      githubAppType: 'standard',
    });
    serviceMocks.getTokenForRepo.mockRejectedValueOnce(new Error('repository not accessible'));

    await expect(
      createService().getTokenForRepo({ githubRepo: 'renamed-owner/repository', userId: 'user-1' })
    ).rejects.toThrow('repository not accessible');
    expect(serviceMocks.getToken).not.toHaveBeenCalled();
  });

  it.each([undefined, '00000000-0000-4000-8000-000000000001'])(
    'repairs stale login metadata within the expected integration fence for owner scope %s',
    async orgId => {
      const params = {
        githubRepo: 'acme/repository',
        userId: 'user-1',
        orgId,
        expectedIntegrationId: '00000000-0000-4000-8000-000000000002',
      };
      serviceMocks.findInstallationId
        .mockResolvedValueOnce({ success: false, reason: 'integration_mismatch' })
        .mockResolvedValueOnce({
          success: true,
          integrationId: params.expectedIntegrationId,
          integrationOwner:
            orgId === undefined ? { type: 'user', id: 'user-1' } : { type: 'org', id: orgId },
          installationId: '123',
          accountLogin: 'acme',
          githubAppType: 'standard',
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
      serviceMocks.getTokenForRepo.mockResolvedValue('scoped-token');
      vi.spyOn(console, 'log').mockImplementation(() => {});

      await expect(createService().getTokenForRepo(params)).resolves.toMatchObject({
        success: true,
        token: 'scoped-token',
        integrationId: params.expectedIntegrationId,
      });
      expect(serviceMocks.findInstallationId).toHaveBeenCalledTimes(2);
      expect(serviceMocks.findRefreshCandidates).toHaveBeenCalledWith(params);
      expect(serviceMocks.updateAccountLogin).toHaveBeenCalledWith(
        params.expectedIntegrationId,
        'acme'
      );
    }
  );
});

const outboundContainerId = 'outbound-container-1';

describe('GitTokenRPCEntrypoint GitHub launch integration identity', () => {
  const integration: ManagedInstallationLookupSuccess = {
    success: true,
    integrationId: '00000000-0000-4000-8000-000000000002',
    integrationOwner: { type: 'user', id: 'user_1' },
    installationId: '123',
    accountLogin: 'acme',
    githubAppType: 'standard',
    repoName: 'repo',
    permissions: { contents: 'write', pull_requests: 'write' },
  };
  const userAuthor = { name: 'octocat', email: '1+octocat@users.noreply.github.com' };
  const installationAuthor = {
    name: 'kiloconnect[bot]',
    email: '240665456+kiloconnect[bot]@users.noreply.github.com',
  };
  const codec = new GitHubSessionCapabilityCodec(Buffer.alloc(32, 7).toString('base64'));

  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.findInstallationId.mockResolvedValue(integration);
    serviceMocks.findManagedInstallationForRepo.mockResolvedValue(integration);
    serviceMocks.findRefreshCandidates.mockResolvedValue({ success: true, candidates: [] });
    serviceMocks.getTokenForRepo.mockResolvedValue('installation-token');
    serviceMocks.selectUserAuthorization.mockResolvedValue({
      selected: true,
      token: 'user-token',
      gitAuthor: userAuthor,
    });
  });

  describe.each([undefined, integration.integrationId, '00000000-0000-4000-8000-000000000099'])(
    'caller pin %s',
    expectedIntegrationId => {
      it.each([false, true])(
        'returns and seals the authorized identity with user authorization %s',
        async allowUserAuthorization => {
          const params = {
            githubRepo: 'acme/repo',
            userId: 'user_1',
            expectedIntegrationId,
            allowUserAuthorization,
            outboundContainerId,
          };
          const expectedMetadata = {
            success: true,
            integrationId: integration.integrationId,
            integrationOwner: { type: 'user', id: 'user_1' },
            installationId: '123',
            accountLogin: 'acme',
            appType: 'standard',
            ...(allowUserAuthorization
              ? { source: 'user', gitAuthor: userAuthor, commitCoAuthor: installationAuthor }
              : { source: 'installation', gitAuthor: installationAuthor }),
          };
          const service = createService();
          await expect(service.getCloudAgentAuthForRepo(params)).resolves.toEqual({
            ...expectedMetadata,
            githubToken: allowUserAuthorization ? 'user-token' : 'installation-token',
          });
          const issued = await service.issueGitHubSessionCapability(params);
          expect(issued).toEqual({ ...expectedMetadata, capability: expect.any(String) });
          if (!issued.success) throw new Error('Expected capability');
          expect(codec.decode(issued.capability)).toMatchObject({
            integrationId: integration.integrationId,
            owner: 'acme',
            repo: 'repo',
          });
          expect(issued).not.toHaveProperty('githubToken');
        }
      );
    }
  );

  it.each([
    'no_user_authorization',
    'revoked',
    'refresh_failed',
    'insufficient_user_access',
    'credential_unreadable',
    'credential_configuration_error',
  ])('retains the resolved identity when user selection falls back for %s', async reason => {
    serviceMocks.selectUserAuthorization.mockResolvedValue({ selected: false, reason });
    await expect(
      createService().getCloudAgentAuthForRepo({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        allowUserAuthorization: true,
      })
    ).resolves.toEqual({
      success: true,
      integrationId: integration.integrationId,
      integrationOwner: { type: 'user', id: 'user_1' },
      githubToken: 'installation-token',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
      source: 'installation',
      gitAuthor: installationAuthor,
      fallbackReason: reason,
    });
  });

  it.each(['lite_installation', 'insufficient_user_access'])(
    'retains the resolved identity for the installation fallback %s',
    async fallbackReason => {
      const githubAppType = fallbackReason === 'lite_installation' ? 'lite' : 'standard';
      serviceMocks.findManagedInstallationForRepo.mockResolvedValue({
        ...integration,
        githubAppType,
        permissions: { contents: 'read' },
      });
      await expect(
        createService().getCloudAgentAuthForRepo({
          githubRepo: 'acme/repo',
          userId: 'user_1',
          allowUserAuthorization: true,
        })
      ).resolves.toMatchObject({
        success: true,
        integrationId: integration.integrationId,
        githubToken: 'installation-token',
        source: 'installation',
        appType: githubAppType,
        fallbackReason,
      });
      expect(serviceMocks.selectUserAuthorization).not.toHaveBeenCalled();
    }
  );

  describe.each([undefined, '00000000-0000-4000-8000-000000000001'])('owner scope %s', orgId => {
    const actor = { userId: 'user_1', ...(orgId === undefined ? {} : { orgId }) };

    it.each([false, true])(
      'retains the exact integration after managed login repair with user authorization %s',
      async allowUserAuthorization => {
        serviceMocks.findManagedInstallationForRepo.mockResolvedValueOnce({
          success: false,
          reason: 'integration_mismatch',
        });
        serviceMocks.findRefreshCandidates.mockResolvedValue({
          success: true,
          candidates: [
            {
              integrationId: integration.integrationId,
              installationId: '123',
              accountLogin: 'old-acme',
              githubAppType: 'standard',
            },
          ],
        });
        serviceMocks.refreshInstallationAccountLoginIfDue.mockResolvedValue('acme');
        serviceMocks.updateAccountLogin.mockResolvedValue(true);
        vi.spyOn(console, 'log').mockImplementation(() => {});
        await expect(
          createService().getCloudAgentAuthForRepo({
            ...actor,
            githubRepo: 'acme/repo',
            expectedIntegrationId: integration.integrationId,
            allowUserAuthorization,
          })
        ).resolves.toMatchObject({
          success: true,
          integrationId: integration.integrationId,
          githubToken: allowUserAuthorization ? 'user-token' : 'installation-token',
          source: allowUserAuthorization ? 'user' : 'installation',
        });
      }
    );

    describe.each([undefined, outboundContainerId])('capability container %s', containerId => {
      const container = containerId === undefined ? {} : { outboundContainerId: containerId };

      it.each([false, true])(
        'pins a legacy request through token refresh with user authorization %s',
        async allowUserAuthorization => {
          const service = createService();
          const issued = await service.issueGitHubSessionCapability({
            ...actor,
            ...container,
            githubRepo: 'acme/repo',
            allowUserAuthorization,
          });
          if (!issued.success) throw new Error('Expected capability');
          expect(issued.integrationId).toBe(integration.integrationId);
          serviceMocks.findManagedInstallationForRepo.mockImplementation(
            async (params: FindInstallationParams) =>
              params.expectedIntegrationId === integration.integrationId
                ? integration
                : { success: false, reason: 'integration_mismatch' }
          );
          serviceMocks.getTokenForRepo.mockResolvedValue('refreshed-installation-token');
          serviceMocks.selectUserAuthorization.mockResolvedValue({
            selected: true,
            token: 'refreshed-user-token',
            gitAuthor: userAuthor,
          });
          await expect(
            service.redeemGitHubSessionCapability({
              capability: issued.capability,
              ...container,
              requestMethod: 'GET',
              requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
            })
          ).resolves.toEqual({
            success: true,
            authorization: allowUserAuthorization
              ? 'Bearer refreshed-user-token'
              : 'Bearer refreshed-installation-token',
          });
        }
      );

      it.each([false, true])(
        'rejects replacement after an unpinned request with user authorization %s',
        async allowUserAuthorization => {
          const service = createService();
          const issued = await service.issueGitHubSessionCapability({
            ...actor,
            ...container,
            githubRepo: 'acme/repo',
            allowUserAuthorization,
          });
          if (!issued.success) throw new Error('Expected capability');
          serviceMocks.findManagedInstallationForRepo.mockImplementation(
            async (params: FindInstallationParams) =>
              params.expectedIntegrationId === undefined
                ? { ...integration, integrationId: '00000000-0000-4000-8000-000000000099' }
                : { success: false, reason: 'integration_mismatch' }
          );
          await expect(
            service.redeemGitHubSessionCapability({
              capability: issued.capability,
              ...container,
              requestMethod: 'GET',
              requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
            })
          ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
        }
      );

      it.each([false, true])(
        'redeems an old unpinned capability with user authorization %s',
        async allowUserAuthorization => {
          const capability = codec.issue({
            ...actor,
            ...container,
            owner: 'acme',
            repo: 'repo',
            source: allowUserAuthorization ? 'user' : 'installation',
            identity: {
              installationId: '123',
              accountLogin: 'acme',
              appType: 'standard',
              gitAuthor: allowUserAuthorization ? userAuthor : installationAuthor,
              ...(allowUserAuthorization ? { commitCoAuthor: installationAuthor } : {}),
            },
          });
          serviceMocks.findManagedInstallationForRepo.mockImplementation(
            async (params: FindInstallationParams) =>
              params.expectedIntegrationId === undefined
                ? integration
                : { success: false, reason: 'integration_mismatch' }
          );
          const service = createService();
          await expect(
            service.redeemGitHubSessionCapability({
              capability,
              ...container,
              requestMethod: 'GET',
              requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
            })
          ).resolves.toEqual({
            success: true,
            authorization: allowUserAuthorization
              ? 'Bearer user-token'
              : 'Bearer installation-token',
          });
          if (containerId === undefined) {
            await expect(
              service.redeemGitHubSessionCapability({
                capability,
                requestMethod: 'GET',
                requestUrl: 'https://api.github.com/repos/acme/other/pulls/42',
              })
            ).resolves.toEqual({ success: false, reason: 'repository_mismatch' });
          }
        }
      );
    });
  });

  async function usePersonalInstallationLookup() {
    const { InstallationLookupService } = await vi.importActual<
      typeof InstallationLookupServiceModule
    >('./installation-lookup-service.js');
    const row = {
      id: integration.integrationId,
      platform_installation_id: '123',
      platform_account_login: 'acme',
      github_app_type: 'standard',
      integration_status: 'active',
      owned_by_organization_id: null,
      owned_by_user_id: 'user_1',
      repository_access: 'all',
      repositories: null,
      permissions: { contents: 'write', pull_requests: 'write' },
    };
    const query = {
      from: vi.fn(() => query),
      leftJoin: vi.fn(() => query),
      innerJoin: vi.fn(() => query),
      where: vi.fn(() => query),
      orderBy: vi.fn(() => query),
      limit: vi.fn(async () => [row]),
    };
    vi.spyOn(dbClient, 'getWorkerDb').mockReturnValue({ select: () => query } as never);
    const lookup = new InstallationLookupService({
      HYPERDRIVE: { connectionString: 'postgres://test' },
    } as CloudflareEnv);
    serviceMocks.findInstallationId.mockImplementation((params: FindInstallationParams) =>
      lookup.findInstallationId(params)
    );
    serviceMocks.findManagedInstallationForRepo.mockImplementation(
      (params: FindInstallationParams) => lookup.findManagedInstallationForRepo(params)
    );
    return row;
  }

  it('keeps an authorized legacy Personal fallback redeemable in an organization session', async () => {
    await usePersonalInstallationLookup();
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      orgId: '00000000-0000-4000-8000-000000000001',
      outboundContainerId,
    });
    expect(issued).toMatchObject({ success: true, integrationId: integration.integrationId });
    if (!issued.success) throw new Error('Expected capability');
    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
      })
    ).resolves.toEqual({ success: true, authorization: 'Bearer installation-token' });
  });

  const organizationSession = {
    githubRepo: 'acme/repo',
    userId: 'user_1',
    orgId: '00000000-0000-4000-8000-000000000001',
  };

  it('retains the resolved Personal owner across raw-token retries in an organization session', async () => {
    await usePersonalInstallationLookup();
    const service = createService();
    const resolved = await service.getTokenForRepo(organizationSession);
    expect(resolved).toEqual({
      success: true,
      token: 'installation-token',
      integrationId: integration.integrationId,
      integrationOwner: { type: 'user', id: 'user_1' },
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
    });
    if (!resolved.success) throw new Error('Expected raw token');
    serviceMocks.getTokenForRepo.mockResolvedValue('refreshed-installation-token');
    await expect(
      service.getTokenForRepo({
        ...organizationSession,
        expectedIntegrationId: resolved.integrationId,
        expectedIntegrationOwner: resolved.integrationOwner,
      })
    ).resolves.toEqual({ ...resolved, token: 'refreshed-installation-token' });
  });

  describe.each([undefined, outboundContainerId])('Personal fallback container %s', containerId => {
    const container = containerId === undefined ? {} : { outboundContainerId: containerId };

    it.each([false, true])(
      'retains the owner across capability retries with user authorization %s',
      async allowUserAuthorization => {
        await usePersonalInstallationLookup();
        const service = createService();
        const params = { ...organizationSession, ...container, allowUserAuthorization };
        const issued = await service.issueGitHubSessionCapability(params);
        expect(issued).toMatchObject({
          success: true,
          integrationId: integration.integrationId,
          integrationOwner: { type: 'user', id: 'user_1' },
        });
        if (!issued.success) throw new Error('Expected capability');
        expect(codec.decode(issued.capability)).toMatchObject({
          orgId: organizationSession.orgId,
          integrationId: integration.integrationId,
          integrationOwner: { type: 'user', id: 'user_1' },
        });
        const retried = await service.issueGitHubSessionCapability({
          ...params,
          expectedIntegrationId: issued.integrationId,
          expectedIntegrationOwner: issued.integrationOwner,
        });
        expect(retried).toMatchObject({
          success: true,
          integrationId: integration.integrationId,
          integrationOwner: { type: 'user', id: 'user_1' },
        });
        if (!retried.success) throw new Error('Expected retry capability');
        serviceMocks.getTokenForRepo.mockResolvedValue('refreshed-installation-token');
        serviceMocks.selectUserAuthorization.mockResolvedValue({
          selected: true,
          token: 'refreshed-user-token',
          gitAuthor: userAuthor,
        });
        for (const { capability } of [issued, retried]) {
          await expect(
            service.redeemGitHubSessionCapability({
              capability,
              ...container,
              requestMethod: 'GET',
              requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
            })
          ).resolves.toEqual({
            success: true,
            authorization: allowUserAuthorization
              ? 'Bearer refreshed-user-token'
              : 'Bearer refreshed-installation-token',
          });
        }
      }
    );

    it.each([false, true])(
      'preserves old unpinned fallback and organization-only pin semantics with user authorization %s',
      async allowUserAuthorization => {
        const row = await usePersonalInstallationLookup();
        const subject = {
          userId: organizationSession.userId,
          orgId: organizationSession.orgId,
          ...container,
          owner: 'acme',
          repo: 'repo',
          source: allowUserAuthorization ? ('user' as const) : ('installation' as const),
          identity: {
            installationId: '123',
            accountLogin: 'acme',
            appType: 'standard' as const,
            gitAuthor: allowUserAuthorization ? userAuthor : installationAuthor,
            ...(allowUserAuthorization ? { commitCoAuthor: installationAuthor } : {}),
          },
        };
        const service = createService();
        const request = {
          ...container,
          requestMethod: 'GET',
          requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
        };
        const expected = {
          success: true,
          authorization: allowUserAuthorization ? 'Bearer user-token' : 'Bearer installation-token',
        };
        await expect(
          service.redeemGitHubSessionCapability({
            ...request,
            capability: codec.issue(subject),
          })
        ).resolves.toEqual(expected);
        const pinned = codec.issue({ ...subject, integrationId: integration.integrationId });
        await expect(
          service.redeemGitHubSessionCapability({ ...request, capability: pinned })
        ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
        const personalPinned = codec.issue({
          ...subject,
          orgId: undefined,
          integrationId: integration.integrationId,
        });
        await expect(
          service.redeemGitHubSessionCapability({ ...request, capability: personalPinned })
        ).resolves.toEqual(expected);
        Object.assign(row, {
          owned_by_organization_id: organizationSession.orgId,
          owned_by_user_id: null,
        });
        await expect(
          service.redeemGitHubSessionCapability({ ...request, capability: pinned })
        ).resolves.toEqual(expected);
        await expect(
          service.redeemGitHubSessionCapability({ ...request, capability: personalPinned })
        ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
      }
    );
  });

  it.each([
    [
      'transferred to the session organization',
      {
        owned_by_organization_id: organizationSession.orgId,
        owned_by_user_id: null,
      },
    ],
    ['transferred to another user', { owned_by_user_id: 'oauth/another-user' }],
    ['replaced', { id: '00000000-0000-4000-8000-000000000099' }],
    ['suspended', { integration_status: 'suspended' }],
    [
      'removed from the repository',
      {
        repository_access: 'selected',
        repositories: [{ full_name: 'acme/other-repo' }],
      },
    ],
  ])(
    'rejects raw retries and redemption after the Personal integration is %s',
    async (_name, change) => {
      const row = await usePersonalInstallationLookup();
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        ...organizationSession,
        outboundContainerId,
      });
      if (!issued.success) throw new Error('Expected capability');
      Object.assign(row, change);
      await expect(
        service.getTokenForRepo({
          ...organizationSession,
          expectedIntegrationId: issued.integrationId,
          expectedIntegrationOwner: issued.integrationOwner,
        })
      ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
      await expect(
        service.redeemGitHubSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod: 'GET',
          requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
        })
      ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
    }
  );

  it.each([false, true])(
    'rejects a changed integration owner with identical provider identity and user authorization %s',
    async allowUserAuthorization => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId,
        allowUserAuthorization,
      });
      if (!issued.success) throw new Error('Expected capability');
      serviceMocks.findManagedInstallationForRepo.mockResolvedValue({
        ...integration,
        integrationOwner: { type: 'org', id: organizationSession.orgId },
      });
      await expect(
        service.redeemGitHubSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod: 'GET',
          requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
        })
      ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
    }
  );

  it.each([false, true])(
    'rejects a changed integration with identical provider identity and user authorization %s',
    async allowUserAuthorization => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId,
        allowUserAuthorization,
      });
      if (!issued.success) throw new Error('Expected capability');
      serviceMocks.findManagedInstallationForRepo.mockResolvedValue({
        ...integration,
        integrationId: '00000000-0000-4000-8000-000000000099',
      });
      await expect(
        service.redeemGitHubSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod: 'GET',
          requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
        })
      ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
    }
  );

  it.each([
    ['database_not_configured', 'database_not_configured'],
    ['invalid_repo_format', 'invalid_repo_format'],
    ['no_installation_found', 'no_installation_found'],
    ['invalid_org_id', 'invalid_org_id'],
    ['integration_mismatch', 'integration_mismatch'],
    ['ambiguous_installation', 'no_installation_found'],
  ])('preserves the public error for lookup failure %s', async (reason, publicReason) => {
    serviceMocks.findInstallationId.mockResolvedValue({ success: false, reason });
    serviceMocks.findManagedInstallationForRepo.mockResolvedValue({ success: false, reason });
    const service = createService();
    const params = { githubRepo: 'acme/repo', userId: 'user_1' };
    const failure = { success: false, reason: publicReason };
    await expect(service.getTokenForRepo(params)).resolves.toEqual(failure);
    await expect(service.getCloudAgentAuthForRepo(params)).resolves.toEqual(failure);
    await expect(service.issueGitHubSessionCapability(params)).resolves.toEqual(failure);
  });
});

describe('GitTokenRPCEntrypoint GitHub session capability RPCs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.findManagedInstallationForRepo.mockResolvedValue({
      success: true,
      integrationId: '00000000-0000-4000-8000-000000000002',
      integrationOwner: { type: 'user', id: 'user_1' },
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

  it('issues an opaque GitHub capability while preserving non-secret attribution metadata', async () => {
    const result = await createService().issueGitHubSessionCapability({
      githubRepo: 'Acme/Repo',
      userId: 'user_1',
      outboundContainerId,
      allowUserAuthorization: true,
    });

    expect(result).toMatchObject({
      success: true,
      source: 'user',
      installationId: '123',
      accountLogin: 'acme',
      appType: 'standard',
      gitAuthor: { name: 'octocat' },
    });
    if (!result.success) throw new Error('Expected successful issuance');
    expect(result.capability).toMatch(/^kgh2\./);
    expect(JSON.stringify(result)).not.toContain('user-token');
    expect(result).not.toHaveProperty('githubToken');
  });

  it('does not expose an installation token in an installation-source issuance result', async () => {
    const result = await createService().issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });

    expect(result).toMatchObject({ success: true, source: 'installation' });
    if (!result.success) throw new Error('Expected successful issuance');
    expect(JSON.stringify(result)).not.toContain('installation-token');
    expect(result.capability).not.toContain('installation-token');
    expect(result).not.toHaveProperty('githubToken');
    expect(result).not.toHaveProperty('token');
  });

  it('preserves an expected integration fence through capability redemption', async () => {
    const expectedIntegrationId = '00000000-0000-4000-8000-000000000002';
    const orgId = '00000000-0000-4000-8000-000000000001';
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      orgId,
      expectedIntegrationId,
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    expect(serviceMocks.findManagedInstallationForRepo).toHaveBeenLastCalledWith({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      orgId,
      expectedIntegrationId,
      outboundContainerId,
    });
    serviceMocks.findManagedInstallationForRepo.mockClear();

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toMatchObject({ success: true });
    expect(serviceMocks.findManagedInstallationForRepo).toHaveBeenLastCalledWith({
      userId: 'user_1',
      orgId,
      expectedIntegrationId,
      expectedIntegrationOwner: { type: 'user', id: 'user_1' },
      githubRepo: 'acme/repo',
    });
  });

  it('returns integration_mismatch when repair cannot restore a capability fence', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      orgId: '00000000-0000-4000-8000-000000000001',
      expectedIntegrationId: '00000000-0000-4000-8000-000000000002',
      outboundContainerId,
      allowUserAuthorization: true,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.getTokenForRepo.mockClear();
    serviceMocks.findManagedInstallationForRepo.mockClear();
    serviceMocks.findManagedInstallationForRepo.mockResolvedValue({
      success: false,
      reason: 'integration_mismatch',
    });
    serviceMocks.findRefreshCandidates.mockResolvedValue({ success: true, candidates: [] });

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'integration_mismatch' });
    expect(serviceMocks.findManagedInstallationForRepo).toHaveBeenCalledTimes(2);
    expect(serviceMocks.findRefreshCandidates).toHaveBeenCalledWith({
      userId: 'user_1',
      orgId: '00000000-0000-4000-8000-000000000001',
      expectedIntegrationId: '00000000-0000-4000-8000-000000000002',
      expectedIntegrationOwner: { type: 'user', id: 'user_1' },
      githubRepo: 'acme/repo',
    });
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('returns a sanitized declared failure when capability key configuration is invalid', async () => {
    const service = new GitTokenRPCEntrypoint(
      {} as ExecutionContext,
      {
        GITHUB_APP_SLUG: 'kiloconnect',
        GITHUB_APP_BOT_USER_ID: '240665456',
        SCM_SESSION_CAPABILITY_ENCRYPTION_KEY: 'not-a-valid-key',
      } as unknown as CloudflareEnv
    );

    await expect(
      service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId,
      })
    ).resolves.toEqual({ success: false, reason: 'capability_configuration_error' });
  });

  it('does not redeem a capability from another outbound container or resolve authorization', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findManagedInstallationForRepo.mockClear();
    serviceMocks.getTokenForRepo.mockClear();

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId: 'another-outbound-container',
        requestMethod: 'GET',
        requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'container_mismatch' });
    expect(serviceMocks.findManagedInstallationForRepo).not.toHaveBeenCalled();
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('does not redeem a bound capability without an outbound container or resolve authorization', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findManagedInstallationForRepo.mockClear();
    serviceMocks.getTokenForRepo.mockClear();

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        requestMethod: 'GET',
        requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'container_mismatch' });
    expect(serviceMocks.findManagedInstallationForRepo).not.toHaveBeenCalled();
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('temporarily issues and redeems a legacy unbound GitHub capability for an old caller', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    expect(issued.capability).toMatch(/^kgh1\./);
    serviceMocks.getTokenForRepo.mockClear();

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        requestMethod: 'GET',
        requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toEqual({
      success: true,
      authorization: `Basic ${Buffer.from('x-access-token:installation-token').toString('base64')}`,
    });
    expect(serviceMocks.getTokenForRepo).toHaveBeenCalledOnce();
  });

  it.each([
    ['POST', 'https://api.github.com/graphql'],
    ['GET', 'https://github.com/acme/other.git/info/refs?service=git-upload-pack'],
  ] as const)(
    'keeps legacy unbound GitHub capabilities repository-confined for %s %s',
    async (requestMethod, requestUrl) => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      expect(issued.capability).toMatch(/^kgh1\./);
      serviceMocks.getTokenForRepo.mockClear();

      await expect(
        service.redeemGitHubSessionCapability({
          capability: issued.capability,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({ success: false, reason: 'repository_mismatch' });
      expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
    }
  );

  it('rejects tampered capabilities before resolving any upstream authorization', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findManagedInstallationForRepo.mockClear();
    serviceMocks.getTokenForRepo.mockClear();

    const changedOffset = issued.capability.lastIndexOf('.') + 4;
    const changedCharacter = issued.capability[changedOffset] === 'A' ? 'B' : 'A';
    const tamperedCapability = `${issued.capability.slice(0, changedOffset)}${changedCharacter}${issued.capability.slice(changedOffset + 1)}`;
    await expect(
      service.redeemGitHubSessionCapability({
        capability: tamperedCapability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'invalid_capability' });
    expect(serviceMocks.findManagedInstallationForRepo).not.toHaveBeenCalled();
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', 'https://github.com/Acme/Repo.git/info/refs?service=git-upload-pack'],
    ['GET', 'https://github.com/acme/repo.git/info/refs?service=git-receive-pack'],
    ['POST', 'https://github.com/acme/repo.git/git-upload-pack'],
    ['POST', 'https://github.com/acme/repo.git/git-receive-pack'],
  ] as const)(
    'redeems an installation-pinned capability for %s Git URL %s',
    async (requestMethod, requestUrl) => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'Acme/Repo',
        userId: 'user_1',
        outboundContainerId,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.getTokenForRepo.mockClear();

      const redemption = await service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod,
        requestUrl,
      });

      expect(redemption).toEqual({
        success: true,
        authorization: `Basic ${Buffer.from('x-access-token:installation-token').toString('base64')}`,
      });
      expect(serviceMocks.selectUserAuthorization).not.toHaveBeenCalled();
      expect(serviceMocks.getTokenForRepo).toHaveBeenCalledOnce();
    }
  );

  it('returns a sanitized failure when installation token generation fails during redemption', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.getTokenForRepo.mockRejectedValueOnce(
      new Error('provider rejected installation token: raw-provider-detail')
    );

    const redemption = await service.redeemGitHubSessionCapability({
      capability: issued.capability,
      outboundContainerId,
      requestMethod: 'GET',
      requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
    });

    expect(redemption).toEqual({ success: false, reason: 'source_unavailable' });
    expect(JSON.stringify(redemption)).not.toContain('raw-provider-detail');
    expect(JSON.stringify(redemption)).not.toContain('provider rejected');
  });

  it.each([
    'https://github.com/acme/repo.git/info/lfs/objects/batch',
    'https://github.com/acme/repo.git/info/lfs/locks/verify',
  ])('redeems an installation-pinned capability for exact LFS control URL %s', async requestUrl => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.getTokenForRepo.mockClear();

    const redemption = await service.redeemGitHubSessionCapability({
      capability: issued.capability,
      outboundContainerId,
      requestMethod: 'POST',
      requestUrl,
    });

    expect(redemption).toEqual({
      success: true,
      authorization: `Basic ${Buffer.from('x-access-token:installation-token').toString('base64')}`,
    });
    expect(serviceMocks.getTokenForRepo).toHaveBeenCalledOnce();
  });

  it.each([
    ['POST', 'https://api.github.com/graphql'],
    ['GET', 'https://api.github.com/user/repos'],
    ['DELETE', 'https://api.github.com/repos/acme/other/issues/42/comments/1'],
    ['GET', 'https://api.github.com/repos/acme/repo/contents/src%2Findex.ts'],
    ['POST', 'https://uploads.github.com/repos/acme/other/releases/1/assets?name=asset.zip'],
    ['POST', 'https://github.com/acme/other.git/info/lfs/objects/batch'],
  ] as const)(
    'redeems an installation-pinned capability for unrestricted GitHub request %s %s',
    async (requestMethod, requestUrl) => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.getTokenForRepo.mockClear();

      await expect(
        service.redeemGitHubSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({
        success: true,
        authorization: requestUrl.startsWith('https://github.com/')
          ? `Basic ${Buffer.from('x-access-token:installation-token').toString('base64')}`
          : 'Bearer installation-token',
      });
      expect(serviceMocks.getTokenForRepo).toHaveBeenCalledOnce();
    }
  );

  it.each([
    ['POST', 'https://api.github.com/repos/acme/repo/issues/42/comments'],
    ['PATCH', 'https://api.github.com/repos/acme/repo/issues/comments/123'],
    ['POST', 'https://api.github.com/repos/acme/repo/pulls/42/reviews'],
  ] as const)(
    'redeems a user-pinned capability for review API request %s %s',
    async (requestMethod, requestUrl) => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId,
        allowUserAuthorization: true,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.selectUserAuthorization.mockClear();
      serviceMocks.selectUserAuthorization.mockResolvedValueOnce({
        selected: true,
        token: 'refreshed-user-token',
        gitAuthor: { name: 'octocat', email: '1+octocat@users.noreply.github.com' },
      });

      const redemption = await service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod,
        requestUrl,
      });

      expect(redemption).toEqual({ success: true, authorization: 'Bearer refreshed-user-token' });
      expect(serviceMocks.selectUserAuthorization).toHaveBeenCalledOnce();
    }
  );

  it('redeems a user-pinned capability for its pull-request REST diff endpoint', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
      allowUserAuthorization: true,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.selectUserAuthorization.mockClear();

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
      })
    ).resolves.toEqual({ success: true, authorization: 'Bearer user-token' });
    expect(serviceMocks.selectUserAuthorization).toHaveBeenCalledOnce();
  });

  it.each([
    ['POST', 'https://api.github.com/graphql'],
    ['GET', 'https://api.github.com/user/repos'],
    ['DELETE', 'https://api.github.com/repos/acme/other/issues/42/comments/1'],
    ['GET', 'https://api.github.com/repos/acme/repo/contents/src%2Findex.ts'],
    ['POST', 'https://uploads.github.com/repos/acme/other/releases/1/assets?name=asset.zip'],
    ['GET', 'https://github.com/acme/other.git/info/refs?service=git-upload-pack'],
  ] as const)(
    'redeems a selected-user capability for unrestricted GitHub request %s %s',
    async (requestMethod, requestUrl) => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId,
        allowUserAuthorization: true,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      expect(issued.source).toBe('user');
      serviceMocks.selectUserAuthorization.mockClear();

      await expect(
        service.redeemGitHubSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({
        success: true,
        authorization: requestUrl.startsWith('https://github.com/')
          ? `Basic ${Buffer.from('x-access-token:user-token').toString('base64')}`
          : 'Bearer user-token',
      });
      expect(serviceMocks.selectUserAuthorization).toHaveBeenCalledOnce();
    }
  );

  it.each([
    [
      'GET',
      'http://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      'invalid_upstream_url',
    ],
    [
      'GET',
      'https://attacker@github.com/acme/repo.git/info/refs?service=git-upload-pack',
      'invalid_upstream_url',
    ],
    [
      'GET',
      'https://github.com.evil.example/acme/repo.git/info/refs?service=git-upload-pack',
      'upstream_host_not_allowed',
    ],
    [
      'GET',
      'https://gitlab.com/acme/repo.git/info/refs?service=git-upload-pack',
      'upstream_host_not_allowed',
    ],
    ['GET', 'https://api.github.com:8443/user/repos', 'upstream_host_not_allowed'],
    ['GET', 'https://api.github.com/user/repos#fragment', 'invalid_upstream_url'],
  ] as const)(
    'rejects unsafe upstream request %s %s without forwarding authorization',
    async (requestMethod, requestUrl, reason) => {
      const service = createService();
      const issued = await service.issueGitHubSessionCapability({
        githubRepo: 'acme/repo',
        userId: 'user_1',
        outboundContainerId,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.getTokenForRepo.mockClear();

      await expect(
        service.redeemGitHubSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({ success: false, reason });
      expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
    }
  );

  it('rejects unsafe selected-user destinations before resolving authorization', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
      allowUserAuthorization: true,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    expect(issued.source).toBe('user');
    serviceMocks.selectUserAuthorization.mockClear();

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'POST',
        requestUrl: 'https://github.com.evil.example/graphql',
      })
    ).resolves.toEqual({ success: false, reason: 'upstream_host_not_allowed' });
    expect(serviceMocks.selectUserAuthorization).not.toHaveBeenCalled();
  });

  it('rejects user-source redemption rather than falling back to installation authorization', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
      allowUserAuthorization: true,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.selectUserAuthorization.mockResolvedValueOnce({
      selected: false,
      reason: 'no_user_authorization',
    });
    serviceMocks.getTokenForRepo.mockClear();

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
      })
    ).resolves.toEqual({ success: false, reason: 'source_unavailable' });
    expect(serviceMocks.getTokenForRepo).not.toHaveBeenCalled();
  });

  it('rejects a user capability if selected attribution identity changes before redemption', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
      allowUserAuthorization: true,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.selectUserAuthorization.mockResolvedValueOnce({
      selected: true,
      token: 'refreshed-other-user-token',
      gitAuthor: { name: 'another-user', email: '2+another-user@users.noreply.github.com' },
    });

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://api.github.com/repos/acme/repo/pulls/42',
      })
    ).resolves.toEqual({ success: false, reason: 'identity_mismatch' });
  });

  it('rejects an installation capability if the resolved installation identity changes', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findManagedInstallationForRepo.mockResolvedValueOnce({
      success: true,
      integrationId: '00000000-0000-4000-8000-000000000002',
      integrationOwner: { type: 'user', id: 'user_1' },
      installationId: '456',
      accountLogin: 'acme',
      githubAppType: 'standard',
      repoName: 'repo',
      permissions: { contents: 'write', pull_requests: 'write' },
    });

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://github.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'identity_mismatch' });
  });

  it('requires the outbound handler to redeem redirected requests again before forwarding auth', async () => {
    const service = createService();
    const issued = await service.issueGitHubSessionCapability({
      githubRepo: 'acme/repo',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');

    await expect(
      service.redeemGitHubSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://redirect.example.com/acme/repo.git/info/refs?service=git-upload-pack',
      })
    ).resolves.toEqual({ success: false, reason: 'upstream_host_not_allowed' });
  });
});

describe('GitTokenRPCEntrypoint Kilo session capability RPCs', () => {
  const kiloTargets = {
    backendBaseUrl: 'https://api.kilo.ai',
    providerBaseUrl: 'https://api.kilo.ai',
    sessionIngestBaseUrl: 'https://ingest.kilosessions.ai',
  };
  const kiloSubject = {
    userId: 'user_1',
    cloudAgentSessionId: 'cloud-agent-session-1',
    kiloSessionId: 'kilo-session-1',
    outboundContainerId,
    userToken: 'raw-user-token',
    targets: kiloTargets,
  };

  it('issues an opaque Kilo capability that does not leak the enclosed token', async () => {
    const result = await createService().issueKiloSessionCapability(kiloSubject);

    expect(result).toMatchObject({ success: true });
    if (!result.success) throw new Error('Expected successful issuance');
    expect(result.capability).toMatch(/^kka1\./);
    expect(result.capability).not.toContain(kiloSubject.userToken);
  });

  it('rejects issuance for malformed targets', async () => {
    const result = await createService().issueKiloSessionCapability({
      ...kiloSubject,
      targets: { ...kiloTargets, backendBaseUrl: 'https://user@api.kilo.ai' },
    });

    expect(result).toEqual({ success: false, reason: 'invalid_targets' });
  });

  it('returns a sanitized declared failure when capability key configuration is invalid', async () => {
    const service = new GitTokenRPCEntrypoint(
      {} as ExecutionContext,
      { SCM_SESSION_CAPABILITY_ENCRYPTION_KEY: 'not-a-valid-key' } as unknown as CloudflareEnv
    );

    await expect(service.issueKiloSessionCapability(kiloSubject)).resolves.toEqual({
      success: false,
      reason: 'capability_configuration_error',
    });
  });

  it('redeems the user token for provider model routes', async () => {
    const service = createService();
    const issued = await service.issueKiloSessionCapability(kiloSubject);
    if (!issued.success) throw new Error('Expected successful issuance');

    await expect(
      service.redeemKiloSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'POST',
        requestUrl: 'https://api.kilo.ai/api/openrouter/v1/chat/completions',
      })
    ).resolves.toEqual({
      success: true,
      authorization: 'Bearer raw-user-token',
      routeClass: 'provider_model',
    });
  });

  it('redeems the user token for backend API routes', async () => {
    const service = createService();
    const issued = await service.issueKiloSessionCapability(kiloSubject);
    if (!issued.success) throw new Error('Expected successful issuance');

    await expect(
      service.redeemKiloSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://api.kilo.ai/api/users/me',
      })
    ).resolves.toEqual({
      success: true,
      authorization: 'Bearer raw-user-token',
      routeClass: 'backend_api',
    });
  });

  it('redeems the user token for session export/import routes', async () => {
    const service = createService();
    const issued = await service.issueKiloSessionCapability(kiloSubject);
    if (!issued.success) throw new Error('Expected successful issuance');

    await expect(
      service.redeemKiloSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://ingest.kilosessions.ai/api/session/kilo-session-1/export',
      })
    ).resolves.toEqual({
      success: true,
      authorization: 'Bearer raw-user-token',
      routeClass: 'session_ingest',
    });
  });

  it('redeems the user token for a bootstrap bound to the Kilo session', async () => {
    const service = createService();
    const issued = await service.issueKiloSessionCapability(kiloSubject);
    if (!issued.success) throw new Error('Expected successful issuance');

    await expect(
      service.redeemKiloSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'POST',
        requestUrl: 'https://ingest.kilosessions.ai/api/session',
        bootstrapKiloSessionId: kiloSubject.kiloSessionId,
      })
    ).resolves.toEqual({
      success: true,
      authorization: 'Bearer raw-user-token',
      routeClass: 'session_ingest',
    });
  });

  it('returns trusted session scope claims only for a broadened child route', async () => {
    const rootKiloSessionId = 'ses_12345678901234567890123456';
    const childKiloSessionId = 'ses_abcdefghijklmnopqrstuvwxyz';
    const service = createService();
    const issued = await service.issueKiloSessionCapability({
      ...kiloSubject,
      kiloSessionId: rootKiloSessionId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');

    await expect(
      service.redeemKiloSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'POST',
        requestUrl: `https://ingest.kilosessions.ai/api/session/${childKiloSessionId}/ingest`,
        sessionIngestProxyVersion: 1,
      })
    ).resolves.toEqual({
      success: true,
      authorization: 'Bearer raw-user-token',
      routeClass: 'session_ingest',
      sessionIngestScope: {
        cloudAgentSessionId: kiloSubject.cloudAgentSessionId,
        rootKiloSessionId,
      },
    });
  });

  it('does not redeem a session ingest route for another Kilo session', async () => {
    const service = createService();
    const issued = await service.issueKiloSessionCapability(kiloSubject);
    if (!issued.success) throw new Error('Expected successful issuance');

    await expect(
      service.redeemKiloSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://ingest.kilosessions.ai/api/session/another-session/export',
      })
    ).resolves.toEqual({ success: false, reason: 'upstream_not_allowed' });
  });

  it('does not leak the user token to another session ingest route on a shared origin', async () => {
    const service = createService();
    const issued = await service.issueKiloSessionCapability({
      ...kiloSubject,
      targets: {
        backendBaseUrl: 'https://api.kilo.ai',
        providerBaseUrl: 'https://api.kilo.ai/api/openrouter',
        sessionIngestBaseUrl: 'https://api.kilo.ai',
      },
    });
    if (!issued.success) throw new Error('Expected successful issuance');

    await expect(
      service.redeemKiloSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://api.kilo.ai/api/session/another-session/export',
      })
    ).resolves.toEqual({ success: false, reason: 'upstream_not_allowed' });
  });

  it('does not redeem a capability from another outbound container', async () => {
    const service = createService();
    const issued = await service.issueKiloSessionCapability(kiloSubject);
    if (!issued.success) throw new Error('Expected successful issuance');

    await expect(
      service.redeemKiloSessionCapability({
        capability: issued.capability,
        outboundContainerId: 'another-outbound-container',
        requestMethod: 'GET',
        requestUrl: 'https://api.kilo.ai/api/users/me',
      })
    ).resolves.toEqual({ success: false, reason: 'container_mismatch' });
  });

  it('rejects redemption against a disallowed upstream', async () => {
    const service = createService();
    const issued = await service.issueKiloSessionCapability(kiloSubject);
    if (!issued.success) throw new Error('Expected successful issuance');

    await expect(
      service.redeemKiloSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://evil.example.com/api/users/me',
      })
    ).resolves.toEqual({ success: false, reason: 'upstream_not_allowed' });
  });
});

describe('GitTokenRPCEntrypoint GitLab session capability RPCs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    serviceMocks.findGitLabIntegration.mockResolvedValue({
      success: true,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'oauth',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: {
        access_token: 'gitlab-oauth-token',
        auth_type: 'oauth',
      },
    });
    serviceMocks.getGitLabToken.mockResolvedValue({
      success: true,
      token: 'gitlab-oauth-token',
      instanceUrl: 'https://gitlab.com',
    });
  });

  it('preserves the selected integration in raw tokens, capability issuance, and redemption', async () => {
    const integrationId = 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145e';
    const actor = { userId: 'oauth/pinned-user', orgId: '123e4567-e89b-12d3-a456-426614174030' };
    const instanceUrl = 'https://gitlab.example.com/gitlab';
    serviceMocks.findGitLabIntegration.mockImplementation(async (context, pin) =>
      context.userId === actor.userId && context.orgId === actor.orgId && pin === integrationId
        ? {
            success: true,
            integrationId,
            integrationType: 'oauth',
            accountId: '73',
            accountLogin: 'selected-provider-user',
            metadata: { auth_type: 'oauth', gitlab_instance_url: instanceUrl },
          }
        : { success: false, reason: 'no_integration_found' }
    );
    serviceMocks.getGitLabToken.mockResolvedValue({
      success: true,
      token: 'selected-token',
      instanceUrl,
    });
    const params = {
      ...actor,
      expectedIntegrationId: integrationId,
      gitUrl: `${instanceUrl}/acme/nested/widgets.git`,
      outboundContainerId,
    };
    const service = createService();
    await expect(
      service.getGitLabToken({ ...params, repositoryUrl: params.gitUrl })
    ).resolves.toMatchObject({ success: true, token: 'selected-token', integrationId });
    const issued = await service.issueGitLabSessionCapability(params);
    expect(issued).toMatchObject({
      success: true,
      integrationId,
      instanceOrigin: instanceUrl,
      projectPath: 'acme/nested/widgets',
      identity: { accountId: '73', accountLogin: 'selected-provider-user' },
    });
    if (!issued.success) throw new Error('Expected capability');
    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: `${instanceUrl}/api/v4/projects/acme%2Fnested%2Fwidgets`,
      })
    ).resolves.toEqual({ success: true, headers: { authorization: 'Bearer selected-token' } });
  });

  it.each([undefined, outboundContainerId])(
    'issues an old-form capability for an authorized instance subpath with container %s',
    async containerId => {
      const instanceUrl = 'https://gitlab.example.com/gitlab+enterprise';
      const integration: GitLabLookupServiceModule.GitLabLookupSuccess = {
        success: true,
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145e',
        integrationType: 'oauth',
        accountId: '73',
        accountLogin: 'selected-provider-user',
        metadata: { auth_type: 'oauth', gitlab_instance_url: instanceUrl },
      };
      serviceMocks.findAuthorizedGitLabIntegrations.mockResolvedValue({
        success: true,
        integrations: [
          {
            ...integration,
            integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
            metadata: { gitlab_instance_url: 'https://gitlab.example.com/gitlab' },
          },
          integration,
        ],
      });
      serviceMocks.findGitLabIntegration.mockImplementation(async (actor, pin) =>
        actor.userId === 'oauth/legacy-user' && pin === integration.integrationId
          ? integration
          : { success: false, reason: 'no_integration_found' }
      );
      serviceMocks.getGitLabToken.mockImplementation(async integrationId =>
        integrationId === integration.integrationId
          ? { success: true, token: 'selected-subpath-token', instanceUrl }
          : { success: false, reason: 'no_token' }
      );
      const service = createService();
      const issued = await service.issueGitLabSessionCapability({
        userId: 'oauth/legacy-user',
        gitUrl: 'https://gitlab.example.com/gitlab+enterprise/acme/widgets.git',
        ...(containerId === undefined ? {} : { outboundContainerId: containerId }),
      });

      expect(issued).toMatchObject({
        success: true,
        integrationId: integration.integrationId,
        instanceOrigin: instanceUrl,
        instanceHost: 'gitlab.example.com',
        projectPath: 'acme/widgets',
        identity: { accountId: '73', accountLogin: 'selected-provider-user' },
      });
      expect(JSON.stringify(issued)).not.toContain('selected-subpath-token');
      if (!issued.success) throw new Error('Expected capability');
      await expect(
        service.redeemGitLabSessionCapability({
          capability: issued.capability,
          ...(containerId === undefined ? {} : { outboundContainerId: containerId }),
          requestMethod: 'GET',
          requestUrl: `${instanceUrl}/api/v4/projects/acme%2Fwidgets/merge_requests/42`,
        })
      ).resolves.toEqual({
        success: true,
        headers: { authorization: 'Bearer selected-subpath-token' },
      });
    }
  );

  it.each([
    ['https://gitlab.com/acme/widgets.git', 'https://gitlab.com', 'gitlab.com', 'acme/widgets'],
    [
      'https://gitlab.example.com/acme/platform/widgets.git',
      'https://gitlab.example.com',
      'gitlab.example.com',
      'acme/platform/widgets',
    ],
  ])(
    'issues an opaque GitLab capability for %s',
    async (gitUrl, instanceUrl, instanceHost, projectPath) => {
      serviceMocks.findGitLabIntegration.mockResolvedValueOnce({
        success: true,
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
        integrationType: 'oauth',
        accountId: '42',
        accountLogin: 'octocat',
        metadata: {
          access_token: 'gitlab-oauth-token',
          auth_type: 'oauth',
          ...(instanceUrl !== 'https://gitlab.com' ? { gitlab_instance_url: instanceUrl } : {}),
        },
      });
      serviceMocks.getGitLabToken.mockResolvedValueOnce({
        success: true,
        token: 'gitlab-oauth-token',
        instanceUrl,
      });

      const result = await createService().issueGitLabSessionCapability({
        gitUrl,
        userId: 'user_1',
        outboundContainerId,
      });

      expect(result).toMatchObject({
        success: true,
        instanceOrigin: instanceUrl,
        instanceHost,
        projectPath,
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
        authType: 'oauth',
        identity: { accountId: '42', accountLogin: 'octocat' },
      });
      if (!result.success) throw new Error('Expected successful issuance');
      expect(result.capability).toMatch(/^kgl2\./);
      expect(JSON.stringify(result)).not.toContain('gitlab-oauth-token');
      expect(result).not.toHaveProperty('token');
    }
  );

  it('reports a missing GitLab integration identity distinctly from a missing token', async () => {
    serviceMocks.findGitLabIntegration.mockResolvedValue({
      success: true,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'oauth',
      accountId: null,
      accountLogin: null,
      metadata: {
        access_token: 'gitlab-oauth-token',
        auth_type: 'oauth',
      },
    });

    await expect(
      createService().issueGitLabSessionCapability({
        gitUrl: 'https://gitlab.com/acme/widgets.git',
        userId: 'user_1',
        outboundContainerId,
      })
    ).resolves.toEqual({ success: false, reason: 'integration_identity_missing' });
  });

  it('does not redeem a capability from another outbound container or resolve its source', async () => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockClear();
    serviceMocks.getGitLabToken.mockClear();

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId: 'another-outbound-container',
        requestMethod: 'GET',
        requestUrl: 'https://gitlab.com/api/v4/projects',
      })
    ).resolves.toEqual({ success: false, reason: 'container_mismatch' });
    expect(serviceMocks.findGitLabIntegration).not.toHaveBeenCalled();
    expect(serviceMocks.getGitLabToken).not.toHaveBeenCalled();
  });

  it('does not redeem a bound capability without an outbound container or resolve its source', async () => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockClear();
    serviceMocks.getGitLabToken.mockClear();

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        requestMethod: 'GET',
        requestUrl: 'https://gitlab.com/api/v4/projects',
      })
    ).resolves.toEqual({ success: false, reason: 'container_mismatch' });
    expect(serviceMocks.findGitLabIntegration).not.toHaveBeenCalled();
    expect(serviceMocks.getGitLabToken).not.toHaveBeenCalled();
  });

  it('keeps OAuth capabilities valid across refresh and rejects credential replacement', async () => {
    const getCredential = vi
      .fn()
      .mockResolvedValueOnce({
        status: 'available',
        token: 'issued-encrypted-token',
        instanceUrl: 'https://gitlab.com',
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
        glabIsOAuth2: true,
        credentialId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145d',
        credentialVersion: 4,
        source: { type: 'integration' },
      })
      .mockResolvedValueOnce({
        status: 'available',
        token: 'refreshed-same-generation-token',
        instanceUrl: 'https://gitlab.com',
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
        glabIsOAuth2: true,
        credentialId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145d',
        credentialVersion: 3,
        source: { type: 'integration' },
      })
      .mockResolvedValueOnce({
        status: 'available',
        token: 'rotated-encrypted-token',
        instanceUrl: 'https://gitlab.com',
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
        glabIsOAuth2: true,
        credentialId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145e',
        credentialVersion: 1,
        source: { type: 'integration' },
      });
    const service = createService();
    Object.assign(service, {
      gitlabCredentialResolver: {
        resolveCredential: getCredential,
        hasProjectCredentialCandidates: vi.fn().mockResolvedValue(false),
      },
    });
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');

    const redemption = {
      capability: issued.capability,
      outboundContainerId,
      requestMethod: 'GET',
      requestUrl: 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/issues',
    };
    await expect(service.redeemGitLabSessionCapability(redemption)).resolves.toEqual({
      success: true,
      headers: { authorization: 'Bearer refreshed-same-generation-token' },
    });
    await expect(
      service.redeemGitLabSessionCapability({
        ...redemption,
      })
    ).resolves.toEqual({ success: false, reason: 'source_unavailable' });
    expect(serviceMocks.getGitLabToken).not.toHaveBeenCalled();
  });

  it('temporarily issues and redeems a legacy unbound GitLab capability for an old caller', async () => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    expect(issued.capability).toMatch(/^kgl1\./);
    serviceMocks.findGitLabIntegration.mockClear();
    serviceMocks.getGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'refreshed-gitlab-token',
      instanceUrl: 'https://gitlab.com',
    });

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        requestMethod: 'GET',
        requestUrl: 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/changes',
      })
    ).resolves.toEqual({
      success: true,
      headers: { authorization: 'Bearer refreshed-gitlab-token' },
    });
    expect(serviceMocks.findGitLabIntegration).toHaveBeenCalledOnce();
    expect(serviceMocks.getGitLabToken).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['POST', 'https://gitlab.com/api/graphql', 'invalid_upstream_request'],
    ['GET', 'https://gitlab.com/api/v4/projects?membership=true', 'invalid_upstream_request'],
    ['GET', 'https://gitlab.com/api/v4/projects/acme%2Fother/issues', 'repository_mismatch'],
    ['CONNECT', 'https://gitlab.com/api/v4/projects', 'invalid_upstream_request'],
    [
      'GET',
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/variables',
      'invalid_upstream_request',
    ],
    [
      'PUT',
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/merge',
      'invalid_upstream_request',
    ],
    [
      'GET',
      'https://gitlab.com/other/project.git/info/refs?service=git-upload-pack',
      'repository_mismatch',
    ],
  ] as const)(
    'keeps legacy unbound GitLab capabilities project-confined for %s %s',
    async (requestMethod, requestUrl, reason) => {
      const service = createService();
      const issued = await service.issueGitLabSessionCapability({
        gitUrl: 'https://gitlab.com/acme/widgets.git',
        userId: 'user_1',
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      expect(issued.capability).toMatch(/^kgl1\./);
      serviceMocks.findGitLabIntegration.mockClear();
      serviceMocks.getGitLabToken.mockClear();

      await expect(
        service.redeemGitLabSessionCapability({
          capability: issued.capability,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({ success: false, reason });
      expect(serviceMocks.findGitLabIntegration).not.toHaveBeenCalled();
      expect(serviceMocks.getGitLabToken).not.toHaveBeenCalled();
    }
  );

  it('issues an opaque project-source capability from a GitLab project response without exposing its token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          id: 42,
          name: 'widgets',
          path_with_namespace: 'acme/widgets',
          web_url: 'https://gitlab.com/acme/widgets',
        })
      )
    );
    serviceMocks.findAuthorizedGitLabIntegrations.mockResolvedValueOnce({
      success: true,
      integrations: [
        {
          integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
          metadata: {
            access_token: 'gitlab-oauth-token',
            auth_type: 'oauth',
            project_tokens: { '42': { token: 'project-access-token' } },
          },
        },
      ],
    });
    serviceMocks.findGitLabIntegration.mockResolvedValue({
      success: true,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'oauth',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: {
        access_token: 'gitlab-oauth-token',
        auth_type: 'oauth',
        project_tokens: { '42': { token: 'project-access-token' } },
      },
    });
    serviceMocks.hasGitLabProjectCredentialCandidates.mockResolvedValueOnce(true);

    const result = await createService().issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
      createdOnPlatform: 'code-review',
    });

    expect(result).toMatchObject({
      success: true,
      source: {
        type: 'project',
        projectId: 42,
        tokenDigest: 'f30b0bf364d41460c0119e521d2af8ae7eeacca9745981678d58b07b13c94edf',
      },
      glabIsOAuth2: false,
    });
    if (!result.success) throw new Error('Expected successful issuance');
    expect(result.capability).toMatch(/^kgl2\./);
    expect(JSON.stringify(result)).not.toContain('project-access-token');
    expect(result).not.toHaveProperty('token');
  });

  it.each([
    [
      'GET',
      'https://gitlab.com/api/v4/projects/42/merge_requests/42/changes',
      { 'PRIVATE-TOKEN': 'project-access-token' },
    ],
    ['POST', 'https://gitlab.com/api/graphql', { 'PRIVATE-TOKEN': 'project-access-token' }],
    [
      'DELETE',
      'https://gitlab.com/api/v4/projects/99/merge_requests/7',
      { 'PRIVATE-TOKEN': 'project-access-token' },
    ],
    [
      'GET',
      'https://gitlab.com/acme/widgets.git/info/refs?service=git-upload-pack',
      { authorization: `Basic ${Buffer.from('oauth2:project-access-token').toString('base64')}` },
    ],
    [
      'GET',
      'https://gitlab.com/other/project.git/info/refs?service=git-upload-pack',
      { authorization: `Basic ${Buffer.from('oauth2:project-access-token').toString('base64')}` },
    ],
    [
      'GET',
      'https://gitlab.com/api/project.git/info/refs?service=git-upload-pack',
      { authorization: `Basic ${Buffer.from('oauth2:project-access-token').toString('base64')}` },
    ],
    [
      'POST',
      'https://gitlab.com/api/v4/project.git/info/lfs/locks/123/unlock',
      { authorization: `Basic ${Buffer.from('oauth2:project-access-token').toString('base64')}` },
    ],
  ] as const)(
    'redeems an unrestricted bound project-source capability server-side for %s %s',
    async (requestMethod, requestUrl, headers) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 42 })));
      const projectIntegration = {
        success: true as const,
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
        integrationType: 'oauth',
        accountId: '42',
        accountLogin: 'octocat',
        metadata: {
          access_token: 'gitlab-oauth-token',
          auth_type: 'oauth' as const,
          project_tokens: { '42': { token: 'project-access-token' } },
        },
      };
      serviceMocks.findAuthorizedGitLabIntegrations.mockResolvedValueOnce({
        success: true,
        integrations: [projectIntegration],
      });
      serviceMocks.findGitLabIntegration.mockResolvedValue(projectIntegration);
      serviceMocks.hasGitLabProjectCredentialCandidates.mockResolvedValueOnce(true);
      const service = createService();
      const issued = await service.issueGitLabSessionCapability({
        gitUrl: 'https://gitlab.com/acme/widgets.git',
        userId: 'user_1',
        outboundContainerId,
        createdOnPlatform: 'code-review',
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.getGitLabToken.mockClear();

      await expect(
        service.redeemGitLabSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({ success: true, headers });
      expect(serviceMocks.getGitLabToken).not.toHaveBeenCalled();
    }
  );

  it('fails closed when a project-source capability token is rotated', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ id: 42 })));
    const projectIntegration = {
      success: true as const,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'oauth',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: {
        access_token: 'gitlab-oauth-token',
        auth_type: 'oauth' as const,
        project_tokens: { '42': { token: 'project-access-token' } },
      },
    };
    serviceMocks.findAuthorizedGitLabIntegrations.mockResolvedValueOnce({
      success: true,
      integrations: [projectIntegration],
    });
    serviceMocks.findGitLabIntegration.mockResolvedValue(projectIntegration);
    serviceMocks.hasGitLabProjectCredentialCandidates.mockResolvedValueOnce(true);
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
      createdOnPlatform: 'code-review',
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockResolvedValueOnce({
      ...projectIntegration,
      metadata: {
        ...projectIntegration.metadata,
        project_tokens: { '42': { token: 'rotated-project-access-token' } },
      },
    });

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://gitlab.com/api/v4/projects/42/merge_requests/42/changes',
      })
    ).resolves.toEqual({ success: false, reason: 'source_unavailable' });
  });

  it.each([
    [
      'GET',
      'https://gitlab.com/acme/widgets.git/info/refs?service=git-upload-pack',
      { authorization: `Basic ${Buffer.from('oauth2:refreshed-gitlab-pat').toString('base64')}` },
    ],
    [
      'GET',
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/changes',
      { authorization: 'Bearer refreshed-gitlab-pat' },
    ],
  ] as const)(
    'redeems an ordinary PAT-source capability server-side for %s %s',
    async (requestMethod, requestUrl, headers) => {
      serviceMocks.findGitLabIntegration.mockResolvedValue({
        success: true,
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
        integrationType: 'pat',
        accountId: '42',
        accountLogin: 'octocat',
        metadata: { access_token: 'gitlab-pat-token', auth_type: 'pat' },
      });
      serviceMocks.getGitLabToken.mockResolvedValueOnce({
        success: true,
        token: 'gitlab-pat-token',
        instanceUrl: 'https://gitlab.com',
      });
      const service = createService();
      const issued = await service.issueGitLabSessionCapability({
        gitUrl: 'https://gitlab.com/acme/widgets.git',
        userId: 'user_1',
        outboundContainerId,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.getGitLabToken.mockResolvedValueOnce({
        success: true,
        token: 'refreshed-gitlab-pat',
        instanceUrl: 'https://gitlab.com',
      });

      await expect(
        service.redeemGitLabSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({ success: true, headers });
    }
  );

  it.each([
    [
      'GET',
      'https://gitlab.example.com:8443/gitlab/acme/platform/widgets.git/info/refs?service=git-upload-pack',
      {
        authorization: `Basic ${Buffer.from('oauth2:refreshed-self-managed-token').toString('base64')}`,
      },
    ],
    [
      'GET',
      'https://gitlab.example.com:8443/gitlab/api/v4/projects/acme%2Fplatform%2Fwidgets/merge_requests/42/changes',
      { authorization: 'Bearer refreshed-self-managed-token' },
    ],
    [
      'POST',
      'https://gitlab.example.com:8443/gitlab/api/graphql',
      { authorization: 'Bearer refreshed-self-managed-token' },
    ],
    [
      'GET',
      'https://gitlab.example.com:8443/gitlab/other/project.git/info/refs?service=git-upload-pack',
      {
        authorization: `Basic ${Buffer.from('oauth2:refreshed-self-managed-token').toString('base64')}`,
      },
    ],
  ] as const)(
    'issues and redeems a nested self-managed GitLab capability for %s %s',
    async (requestMethod, requestUrl, headers) => {
      serviceMocks.findGitLabIntegration.mockResolvedValue({
        success: true,
        integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
        integrationType: 'oauth',
        accountId: '42',
        accountLogin: 'octocat',
        metadata: {
          access_token: 'self-managed-token',
          auth_type: 'oauth',
          gitlab_instance_url: 'https://gitlab.example.com:8443/gitlab',
        },
      });
      serviceMocks.getGitLabToken.mockResolvedValueOnce({
        success: true,
        token: 'self-managed-token',
        instanceUrl: 'https://gitlab.example.com:8443/gitlab',
      });
      const service = createService();
      const issued = await service.issueGitLabSessionCapability({
        gitUrl: 'https://gitlab.example.com:8443/gitlab/acme/platform/widgets.git',
        userId: 'user_1',
        outboundContainerId,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.getGitLabToken.mockResolvedValueOnce({
        success: true,
        token: 'refreshed-self-managed-token',
        instanceUrl: 'https://gitlab.example.com:8443/gitlab',
      });

      await expect(
        service.redeemGitLabSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({ success: true, headers });
    }
  );

  it.each([
    ['https://gitlab.example.com:8443/api/v4/projects/42/issues', 'upstream_origin_not_allowed'],
    [
      'https://gitlab.example.com:8443/acme/platform/widgets.git/info/refs?service=git-upload-pack',
      'upstream_origin_not_allowed',
    ],
    ['https://gitlab.example.com:8443/gitlab/%2e%2e%2fapi/v4/user', 'invalid_upstream_url'],
    ['https://gitlab.example.com:8443/gitlab/%252e%252e%252fapi/v4/user', 'invalid_upstream_url'],
  ] as const)('rejects self-managed base-path escape %s', async (requestUrl, reason) => {
    serviceMocks.findGitLabIntegration.mockResolvedValue({
      success: true,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'oauth',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: {
        access_token: 'self-managed-token',
        auth_type: 'oauth',
        gitlab_instance_url: 'https://gitlab.example.com:8443/gitlab',
      },
    });
    serviceMocks.getGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'self-managed-token',
      instanceUrl: 'https://gitlab.example.com:8443/gitlab',
    });
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.example.com:8443/gitlab/acme/platform/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockClear();

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl,
      })
    ).resolves.toEqual({ success: false, reason });
    expect(serviceMocks.findGitLabIntegration).not.toHaveBeenCalled();
  });

  it('rejects a self-managed sibling origin', async () => {
    const requestUrl =
      'https://sibling.example.com/acme/platform/widgets.git/info/refs?service=git-upload-pack';
    serviceMocks.findGitLabIntegration.mockResolvedValue({
      success: true,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'oauth',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: {
        access_token: 'self-managed-token',
        auth_type: 'oauth',
        gitlab_instance_url: 'https://gitlab.example.com',
      },
    });
    serviceMocks.getGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'self-managed-token',
      instanceUrl: 'https://gitlab.example.com',
    });
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.example.com/acme/platform/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockClear();

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl,
      })
    ).resolves.toEqual({ success: false, reason: 'upstream_origin_not_allowed' });
    expect(serviceMocks.findGitLabIntegration).not.toHaveBeenCalled();
  });

  it('returns a sanitized declared failure when the capability key is invalid', async () => {
    const service = new GitTokenRPCEntrypoint(
      {} as ExecutionContext,
      {
        SCM_SESSION_CAPABILITY_ENCRYPTION_KEY: 'not-a-valid-key',
      } as unknown as CloudflareEnv
    );

    await expect(
      service.issueGitLabSessionCapability({
        gitUrl: 'https://gitlab.com/acme/widgets.git',
        userId: 'user_1',
        outboundContainerId,
      })
    ).resolves.toEqual({ success: false, reason: 'capability_configuration_error' });
  });

  it('does not expose a PAT during issuance', async () => {
    serviceMocks.findGitLabIntegration.mockResolvedValue({
      success: true,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'pat',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: { access_token: 'gitlab-pat-token', auth_type: 'pat' },
    });
    serviceMocks.getGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'gitlab-pat-token',
      instanceUrl: 'https://gitlab.com',
    });

    const result = await createService().issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });

    expect(result).toMatchObject({ success: true, authType: 'pat' });
    expect(JSON.stringify(result)).not.toContain('gitlab-pat-token');
  });

  it.each([
    ['GET', 'https://gitlab.com/acme/widgets.git/info/refs?service=git-upload-pack', 'Basic'],
    ['GET', 'https://gitlab.com/acme/widgets.git/info/refs?service=git-receive-pack', 'Basic'],
    ['POST', 'https://gitlab.com/acme/widgets.git/git-upload-pack', 'Basic'],
    ['POST', 'https://gitlab.com/acme/widgets.git/git-receive-pack', 'Basic'],
    ['POST', 'https://gitlab.com/acme/widgets.git/info/lfs/objects/batch', 'Basic'],
    ['POST', 'https://gitlab.com/acme/widgets.git/info/lfs/locks/verify', 'Basic'],
    [
      'GET',
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/changes',
      'Bearer',
    ],
    ['POST', 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/notes', 'Bearer'],
    [
      'PUT',
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/notes/123',
      'Bearer',
    ],
    [
      'POST',
      'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/discussions',
      'Bearer',
    ],
  ] as const)('redeems allowed GitLab request %s %s', async (requestMethod, requestUrl, scheme) => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockClear();
    serviceMocks.getGitLabToken.mockResolvedValueOnce({
      success: true,
      token: 'refreshed-gitlab-token',
      instanceUrl: 'https://gitlab.com',
    });

    const result = await service.redeemGitLabSessionCapability({
      capability: issued.capability,
      outboundContainerId,
      requestMethod,
      requestUrl,
    });

    const authorization =
      scheme === 'Basic'
        ? `Basic ${Buffer.from('oauth2:refreshed-gitlab-token').toString('base64')}`
        : 'Bearer refreshed-gitlab-token';
    expect(result).toEqual({ success: true, headers: { authorization } });
    expect(serviceMocks.findGitLabIntegration).toHaveBeenCalledWith(
      { userId: 'user_1' },
      'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c'
    );
  });

  it.each([
    ['GET', 'https://gitlab.com/api/v4/projects?membership=true'],
    ['POST', 'https://gitlab.com/api/graphql'],
    ['DELETE', 'https://gitlab.com/api/v4/projects/acme%2Fother/issues/1'],
  ] as const)(
    'redeems an unrestricted bound GitLab integration capability for API request %s %s',
    async (requestMethod, requestUrl) => {
      const service = createService();
      const issued = await service.issueGitLabSessionCapability({
        gitUrl: 'https://gitlab.com/acme/widgets.git',
        userId: 'user_1',
        outboundContainerId,
      });
      if (!issued.success) throw new Error('Expected successful issuance');
      serviceMocks.findGitLabIntegration.mockClear();
      serviceMocks.getGitLabToken.mockResolvedValueOnce({
        success: true,
        token: 'refreshed-gitlab-token',
        instanceUrl: 'https://gitlab.com',
      });

      await expect(
        service.redeemGitLabSessionCapability({
          capability: issued.capability,
          outboundContainerId,
          requestMethod,
          requestUrl,
        })
      ).resolves.toEqual({
        success: true,
        headers: { authorization: 'Bearer refreshed-gitlab-token' },
      });
      expect(serviceMocks.findGitLabIntegration).toHaveBeenCalledOnce();
    }
  );

  it.each([
    [
      'GET',
      'https://other.example.com/acme/widgets.git/info/refs?service=git-upload-pack',
      'upstream_origin_not_allowed',
    ],
    ['GET', 'https://gitlab.com:8443/api/v4/projects', 'upstream_origin_not_allowed'],
    ['GET', 'http://gitlab.com/api/v4/projects', 'invalid_upstream_url'],
    ['GET', 'https://attacker@gitlab.com/api/v4/projects', 'invalid_upstream_url'],
    ['GET', 'https://gitlab.com/api/v4/projects#fragment', 'invalid_upstream_url'],
    ['GET', 'https://gitlab.com/../api/v4/projects', 'invalid_upstream_url'],
    [
      'GET',
      'https://gitlab.com/acme%5Cwidgets.git/info/refs?service=git-upload-pack',
      'invalid_upstream_url',
    ],
  ] as const)('rejects unsafe GitLab request %s %s', async (requestMethod, requestUrl, reason) => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockClear();

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod,
        requestUrl,
      })
    ).resolves.toEqual({ success: false, reason });
    expect(serviceMocks.findGitLabIntegration).not.toHaveBeenCalled();
  });

  it('fails closed if the pinned GitLab integration disappears', async () => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockResolvedValueOnce({
      success: false,
      reason: 'no_integration_found',
    });
    serviceMocks.getGitLabToken.mockClear();

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/changes',
      })
    ).resolves.toEqual({ success: false, reason: 'source_unavailable' });
    expect(serviceMocks.getGitLabToken).not.toHaveBeenCalled();
  });

  it('fails closed if the pinned GitLab integration source identity drifts', async () => {
    const service = createService();
    const issued = await service.issueGitLabSessionCapability({
      gitUrl: 'https://gitlab.com/acme/widgets.git',
      userId: 'user_1',
      outboundContainerId,
    });
    if (!issued.success) throw new Error('Expected successful issuance');
    serviceMocks.findGitLabIntegration.mockResolvedValueOnce({
      success: true,
      integrationId: 'ef2eb5c7-27ce-4f43-b6d3-8f282abc145c',
      integrationType: 'pat',
      accountId: '42',
      accountLogin: 'octocat',
      metadata: { access_token: 'gitlab-pat-token', auth_type: 'pat' },
    });

    await expect(
      service.redeemGitLabSessionCapability({
        capability: issued.capability,
        outboundContainerId,
        requestMethod: 'GET',
        requestUrl: 'https://gitlab.com/api/v4/projects/acme%2Fwidgets/merge_requests/42/changes',
      })
    ).resolves.toEqual({ success: false, reason: 'identity_mismatch' });
    expect(serviceMocks.getGitLabToken).toHaveBeenCalledOnce();
  });
});
