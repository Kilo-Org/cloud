import { describe, expect, it, vi } from 'vitest';
import type { BitbucketWorkspaceAccessTokenAuthorizationResult } from './bitbucket-workspace-access-token-authorization-service.js';
import { BitbucketCodeReviewService } from './bitbucket-code-review-service.js';

const organizationId = '123e4567-e89b-42d3-a456-426614174030';
const integrationId = '123e4567-e89b-42d3-a456-426614174000';
const workspaceUuid = 'a07d5c40-2d2d-4e79-a812-6a47824a77d6';
const repositoryUuid = '38a47a32-cb87-4a9f-b75d-7224774bba77';
const authorUuid = '671c0279-67a5-4d24-8b21-4d6acdfa04d3';
const sourceSha = 'A'.repeat(40);
const destinationSha = 'B'.repeat(40);
const accessToken = 'ATCT-bitbucket-access-token-fixture';
const callbackUrl = `https://app.kilo.ai/api/webhooks/bitbucket/${integrationId}`;
const webhookEvents = [
  'pullrequest:created',
  'pullrequest:updated',
  'pullrequest:fulfilled',
  'pullrequest:rejected',
];

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init?.headers },
  });
}

function webhookPayload(uuid: string, overrides: Record<string, unknown> = {}) {
  return {
    uuid: `{${uuid}}`,
    url: callbackUrl,
    active: true,
    events: webhookEvents,
    secret_set: true,
    ...overrides,
  };
}

function pullRequestRepositoryPayload(overrides: Record<string, unknown> = {}) {
  return {
    uuid: `{${repositoryUuid}}`,
    full_name: 'acme/widgets',
    workspace: { uuid: `{${workspaceUuid}}`, slug: 'acme' },
    ...overrides,
  };
}

function pullRequestPayload(overrides: Record<string, unknown> = {}) {
  return {
    id: 42,
    title: 'Keep the provider boundary semantic',
    state: 'OPEN',
    draft: false,
    updated_on: '2026-06-24T15:30:45.123+02:00',
    author: {
      uuid: `{${authorUuid}}`,
      display_name: 'Ada Reviewer',
    },
    source: {
      repository: pullRequestRepositoryPayload(),
      branch: { name: 'feature/semantic-provider' },
      commit: { hash: sourceSha },
    },
    destination: {
      repository: pullRequestRepositoryPayload(),
      branch: { name: 'main' },
      commit: { hash: destinationSha },
    },
    links: {
      html: { href: 'https://bitbucket.org/acme/widgets/pull-requests/42' },
    },
    ...overrides,
  };
}

type AvailableAuthorization = Extract<
  BitbucketWorkspaceAccessTokenAuthorizationResult,
  { status: 'available' }
>;

function availableAuthorization(
  overrides: Partial<AvailableAuthorization> = {}
): AvailableAuthorization {
  return {
    status: 'available',
    token: accessToken,
    organizationId,
    integrationId,
    credentialId: '123e4567-e89b-42d3-a456-426614174031',
    credentialVersion: 3,
    providerScopes: ['account', 'pullrequest', 'repository', 'repository:write', 'webhook'],
    workspace: { uuid: workspaceUuid, slug: 'acme' },
    ...overrides,
  };
}

function service(
  fetchImplementation: typeof fetch,
  authorization: BitbucketWorkspaceAccessTokenAuthorizationResult = availableAuthorization()
) {
  const getAuthorization = vi.fn().mockResolvedValue(authorization);
  const invalidateAuthorization = vi.fn();
  return {
    codeReviewService: new BitbucketCodeReviewService({} as CloudflareEnv, {
      fetch: fetchImplementation,
      authorizationService: { getAuthorization, invalidateAuthorization },
    }),
    invalidateAuthorization,
  };
}

const workspaceTarget = {
  owner: { userId: 'manager-user', orgId: organizationId },
  integrationId,
  workspaceUuid,
  workspaceSlug: 'acme',
};

const pullRequestTarget = {
  ...workspaceTarget,
  owner: { userId: `bot-code-review-${organizationId}`, orgId: organizationId },
  repositoryUuid,
  repositoryFullName: 'acme/widgets',
  pullRequestId: 42,
};

describe('BitbucketCodeReviewService', () => {
  it('calls default global fetch with the global object binding', async () => {
    const originalFetch = globalThis.fetch;
    const getAuthorization = vi.fn().mockResolvedValue(availableAuthorization());
    const invalidateAuthorization = vi.fn();
    const fetchMock = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError('Illegal invocation');
      return Promise.resolve(jsonResponse({ pagelen: 50, values: [] }));
    });
    Object.defineProperty(globalThis, 'fetch', {
      value: fetchMock,
      writable: true,
      configurable: true,
    });

    try {
      const codeReviewService = new BitbucketCodeReviewService({} as CloudflareEnv, {
        authorizationService: { getAuthorization, invalidateAuthorization },
      });

      await expect(codeReviewService.listWorkspaceWebhooks(workspaceTarget)).resolves.toEqual({
        success: true,
        webhooks: [],
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(globalThis, 'fetch', {
        value: originalFetch,
        writable: true,
        configurable: true,
      });
    }
  });
});

describe('BitbucketCodeReviewService.ensureWorkspaceWebhook', () => {
  it('converges concurrent workspace creates, removes exact duplicates, and replaces the secret', async () => {
    const keeperUuid = '00000000-0000-4000-8000-000000000001';
    const duplicateUuid = '00000000-0000-4000-8000-000000000002';
    const secret = 'a'.repeat(64);
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ pagelen: 50, values: [] }))
      .mockResolvedValueOnce(jsonResponse(webhookPayload(duplicateUuid), { status: 201 }))
      .mockResolvedValueOnce(
        jsonResponse({
          pagelen: 50,
          values: [webhookPayload(duplicateUuid), webhookPayload(keeperUuid)],
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(webhookPayload(keeperUuid)))
      .mockResolvedValueOnce(jsonResponse({ pagelen: 50, values: [webhookPayload(keeperUuid)] }));
    const { codeReviewService } = service(fetchMock);

    await expect(
      codeReviewService.ensureWorkspaceWebhook({
        ...workspaceTarget,
        callbackUrl,
        secret,
      })
    ).resolves.toEqual({
      success: true,
      webhook: {
        uuid: keeperUuid,
        callbackUrl,
        active: true,
        events: webhookEvents,
        secretSet: true,
      },
    });

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://api.bitbucket.org/2.0/workspaces/acme/hooks?pagelen=50',
      expect.objectContaining({ redirect: 'manual' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://api.bitbucket.org/2.0/workspaces/acme/hooks',
      expect.objectContaining({ method: 'POST', redirect: 'manual' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      4,
      `https://api.bitbucket.org/2.0/workspaces/acme/hooks/${duplicateUuid}`,
      expect.objectContaining({ method: 'DELETE', redirect: 'manual' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      5,
      `https://api.bitbucket.org/2.0/workspaces/acme/hooks/${keeperUuid}`,
      expect.objectContaining({
        method: 'PUT',
        body: JSON.stringify({
          description: 'Kilo Code Reviewer',
          url: callbackUrl,
          active: true,
          events: webhookEvents,
          secret,
        }),
        redirect: 'manual',
      })
    );
  });

  it('deterministically keeps the lowest existing UUID and deletes every exact duplicate', async () => {
    const keeperUuid = '00000000-0000-4000-8000-000000000001';
    const duplicateUuid = '00000000-0000-4000-8000-000000000009';
    const unrelatedUuid = '00000000-0000-4000-8000-000000000003';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          pagelen: 50,
          values: [
            webhookPayload(duplicateUuid),
            webhookPayload(unrelatedUuid, { url: 'https://other.example/webhook' }),
            webhookPayload(keeperUuid, { active: false, secret_set: false }),
          ],
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(jsonResponse(webhookPayload(keeperUuid)))
      .mockResolvedValueOnce(
        jsonResponse({
          pagelen: 50,
          values: [
            webhookPayload(unrelatedUuid, { url: 'https://other.example/webhook' }),
            webhookPayload(keeperUuid),
          ],
        })
      );

    await expect(
      service(fetchMock).codeReviewService.ensureWorkspaceWebhook({
        ...workspaceTarget,
        callbackUrl,
        secret: 'b'.repeat(64),
      })
    ).resolves.toEqual(
      expect.objectContaining({
        success: true,
        webhook: expect.objectContaining({ uuid: keeperUuid }),
      })
    );

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.bitbucket.org/2.0/workspaces/acme/hooks/${duplicateUuid}`,
      expect.objectContaining({ method: 'DELETE' })
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
      `https://api.bitbucket.org/2.0/workspaces/acme/hooks/${unrelatedUuid}`
    );
  });
});

describe('BitbucketCodeReviewService.deleteWorkspaceWebhooks', () => {
  it('deletes every exact callback match and no unrelated workspace hook', async () => {
    const firstUuid = '00000000-0000-4000-8000-000000000001';
    const secondUuid = '00000000-0000-4000-8000-000000000002';
    const unrelatedUuid = '00000000-0000-4000-8000-000000000003';
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          pagelen: 50,
          values: [
            webhookPayload(firstUuid),
            webhookPayload(unrelatedUuid, { url: 'https://other.example/webhook' }),
            webhookPayload(secondUuid, { active: false }),
          ],
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));

    await expect(
      service(fetchMock).codeReviewService.deleteWorkspaceWebhooks({
        ...workspaceTarget,
        callbackUrl,
      })
    ).resolves.toEqual({ success: true });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls.slice(1).map(([endpoint]) => endpoint)).toEqual([
      `https://api.bitbucket.org/2.0/workspaces/acme/hooks/${firstUuid}`,
      `https://api.bitbucket.org/2.0/workspaces/acme/hooks/${secondUuid}`,
    ]);
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(unrelatedUuid);
  });
});

describe('BitbucketCodeReviewService.getPullRequest', () => {
  it('reads one exact same-repository pull request and normalizes updatedOn', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(jsonResponse(pullRequestPayload()));
    const { codeReviewService } = service(fetchMock);

    const result = await codeReviewService.getPullRequest(pullRequestTarget);

    expect(result).toEqual({
      success: true,
      pullRequest: {
        id: 42,
        state: 'OPEN',
        draft: false,
        updatedOn: '2026-06-24T13:30:45.123Z',
        title: 'Keep the provider boundary semantic',
        author: {
          uuid: authorUuid,
          displayName: 'Ada Reviewer',
        },
        source: {
          repositoryUuid,
          repositoryFullName: 'acme/widgets',
          branch: 'feature/semantic-provider',
          sha: sourceSha.toLowerCase(),
        },
        destination: {
          repositoryUuid,
          repositoryFullName: 'acme/widgets',
          branch: 'main',
          sha: destinationSha.toLowerCase(),
        },
        url: 'https://bitbucket.org/acme/widgets/pull-requests/42',
      },
    });
    expect(JSON.stringify(result)).not.toContain(accessToken);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/42',
      expect.objectContaining({
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        redirect: 'manual',
      })
    );
  });

  it('accepts Bitbucket pull request repository payloads without workspace and resolves abbreviated hashes', async () => {
    const abbreviatedHeadSha = 'b2baee27adc2';
    const abbreviatedBaseSha = '50c3b1607dd8';
    const fullHeadSha = `${abbreviatedHeadSha}${'0'.repeat(28)}`;
    const fullBaseSha = `${abbreviatedBaseSha}${'1'.repeat(28)}`;
    const repository = pullRequestRepositoryPayload();
    const repositoryWithoutWorkspace = {
      uuid: repository.uuid,
      full_name: repository.full_name,
    };

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          pullRequestPayload({
            source: {
              repository: repositoryWithoutWorkspace,
              branch: { name: 'feature/semantic-provider' },
              commit: { hash: abbreviatedHeadSha },
            },
            destination: {
              repository: repositoryWithoutWorkspace,
              branch: { name: 'main' },
              commit: { hash: abbreviatedBaseSha },
            },
          })
        )
      )
      .mockResolvedValueOnce(jsonResponse({ hash: fullHeadSha }))
      .mockResolvedValueOnce(jsonResponse({ hash: fullBaseSha }));
    const { codeReviewService } = service(fetchMock);

    const result = await codeReviewService.getPullRequest(pullRequestTarget);

    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        pullRequest: expect.objectContaining({
          source: expect.objectContaining({ sha: fullHeadSha }),
          destination: expect.objectContaining({ sha: fullBaseSha }),
        }),
      })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      `https://api.bitbucket.org/2.0/repositories/acme/widgets/commit/${abbreviatedHeadSha}`,
      expect.objectContaining({ redirect: 'manual' })
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      `https://api.bitbucket.org/2.0/repositories/acme/widgets/commit/${abbreviatedBaseSha}`,
      expect.objectContaining({ redirect: 'manual' })
    );
  });

  it.each([6, 41])('rejects a %i-character commit SHA from Bitbucket', async length => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        pullRequestPayload({
          source: {
            repository: pullRequestRepositoryPayload(),
            branch: { name: 'feature/semantic-provider' },
            commit: { hash: 'a'.repeat(length) },
          },
        })
      )
    );

    await expect(
      service(fetchMock).codeReviewService.getPullRequest(pullRequestTarget)
    ).resolves.toEqual({ success: false, reason: 'temporarily_unavailable' });
  });

  it.each([
    {
      name: 'organization',
      authorization: availableAuthorization({
        organizationId: '00000000-0000-4000-8000-000000000099',
      }),
      reason: 'invalid_request',
    },
    {
      name: 'integration',
      authorization: availableAuthorization({
        integrationId: '00000000-0000-4000-8000-000000000099',
      }),
      reason: 'integration_mismatch',
    },
    {
      name: 'workspace UUID',
      authorization: availableAuthorization({
        workspace: { uuid: '00000000-0000-4000-8000-000000000099', slug: 'acme' },
      }),
      reason: 'workspace_mismatch',
    },
    {
      name: 'workspace slug',
      authorization: availableAuthorization({
        workspace: { uuid: workspaceUuid, slug: 'other-workspace' },
      }),
      reason: 'workspace_mismatch',
    },
    {
      name: 'credential scopes',
      authorization: availableAuthorization({
        providerScopes: ['account', 'repository', 'repository:write', 'pullrequest'],
      }),
      reason: 'insufficient_permissions',
    },
  ])('rejects a mismatched $name before provider access', async testCase => {
    const fetchMock = vi.fn();

    await expect(
      service(fetchMock, testCase.authorization).codeReviewService.getPullRequest(pullRequestTarget)
    ).resolves.toEqual({ success: false, reason: testCase.reason });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports provider permission rejection without invalidating the static credential', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(null, { status: 403 }));
    const { codeReviewService, invalidateAuthorization } = service(fetchMock);

    await expect(codeReviewService.getPullRequest(pullRequestTarget)).resolves.toEqual({
      success: false,
      reason: 'insufficient_permissions',
    });
    expect(invalidateAuthorization).not.toHaveBeenCalled();
  });

  it('stops reading a provider response beyond the byte bound', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      new Response('x'.repeat(256_001), {
        headers: { 'Content-Type': 'application/json' },
      })
    );

    await expect(
      service(fetchMock).codeReviewService.getPullRequest(pullRequestTarget)
    ).resolves.toEqual({ success: false, reason: 'temporarily_unavailable' });
  });

  it('rejects a fork source returned by the exact pull request endpoint', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(
      jsonResponse(
        pullRequestPayload({
          source: {
            repository: pullRequestRepositoryPayload({
              uuid: '{00000000-0000-4000-8000-000000000099}',
              full_name: 'someone/fork',
            }),
            branch: { name: 'feature/from-fork' },
            commit: { hash: sourceSha },
          },
        })
      )
    );

    await expect(
      service(fetchMock).codeReviewService.getPullRequest(pullRequestTarget)
    ).resolves.toEqual({ success: false, reason: 'repository_mismatch' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
