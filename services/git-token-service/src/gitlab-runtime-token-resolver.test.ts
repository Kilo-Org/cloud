import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  resolveGitLabRuntimeToken,
  type GetGitLabTokenParams,
} from './gitlab-runtime-token-resolver.js';
import type { AuthorizedGitLabIntegration } from './gitlab-lookup-service.js';
import type { GitLabCredentialBroker } from './gitlab-credential-broker.js';

const first: AuthorizedGitLabIntegration = {
  integrationId: '123e4567-e89b-12d3-a456-426614174011',
  integrationType: 'oauth',
  accountId: '42',
  accountLogin: 'octocat',
  metadata: { gitlab_instance_url: 'https://gitlab.example.com/gitlab' },
};
const second = { ...first, integrationId: '123e4567-e89b-12d3-a456-426614174012' };
const repositoryUrl = 'https://gitlab.example.com/gitlab/acme/nested/widgets.git';
const owner = { userId: 'oauth/owner' };
const notFound = { success: false, reason: 'no_integration_found' } as const;

function dependencies(integrations: AuthorizedGitLabIntegration[] = [first]) {
  const authorized = (actor: GetGitLabTokenParams) =>
    actor.userId === owner.userId && actor.orgId === undefined;
  return {
    lookupService: {
      findGitLabIntegration: vi.fn(async (actor: GetGitLabTokenParams, id?: string) => {
        const integration = authorized(actor)
          ? integrations.find(item => id === undefined || item.integrationId === id)
          : undefined;
        return integration ? { success: true as const, ...integration } : notFound;
      }),
      findAuthorizedGitLabIntegrations: vi.fn(async (actor: GetGitLabTokenParams) =>
        authorized(actor) && integrations.length
          ? { success: true as const, integrations }
          : notFound
      ),
    },
    credentialResolver: {
      hasProjectCredentialCandidates: vi.fn().mockResolvedValue(true),
      resolveCredential: vi.fn<GitLabCredentialBroker['resolveCredential']>(
        async (_actor, selector) => {
          const integration = integrations.find(
            item => item.integrationId === selector.integrationId
          );
          if (!integration) return { status: 'not_connected' as const };
          return {
            status: 'available' as const,
            integrationId: integration.integrationId,
            token:
              integration.integrationId === first.integrationId ? 'first-token' : 'second-token',
            instanceUrl: integration.metadata.gitlab_instance_url ?? 'https://gitlab.com',
            glabIsOAuth2: selector.credential === 'integration',
            credentialId: '123e4567-e89b-12d3-a456-426614174099',
            credentialVersion: 4,
            source:
              selector.credential === 'integration'
                ? { type: 'integration' as const }
                : { type: 'project' as const, projectId: selector.projectId },
          };
        }
      ),
    },
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('resolveGitLabRuntimeToken exact identity', () => {
  it('keeps a unique old-form OAuth request and fences its stable credential ID', async () => {
    await expect(resolveGitLabRuntimeToken(owner, dependencies())).resolves.toEqual({
      success: true,
      token: 'first-token',
      instanceUrl: 'https://gitlab.example.com/gitlab',
      glabIsOAuth2: true,
      integrationId: first.integrationId,
      source: { type: 'integration', credentialId: '123e4567-e89b-12d3-a456-426614174099' },
    });
  });

  it('selects the pinned integration instead of the first authorized integration', async () => {
    await expect(
      resolveGitLabRuntimeToken(
        { ...owner, repositoryUrl, expectedIntegrationId: second.integrationId },
        dependencies([first, second])
      )
    ).resolves.toMatchObject({
      success: true,
      token: 'second-token',
      integrationId: second.integrationId,
    });
  });

  it.each([undefined, repositoryUrl])('rejects ambiguous old-form identity for %s', async url => {
    const deps = dependencies([first, second]);
    await expect(
      resolveGitLabRuntimeToken({ ...owner, repositoryUrl: url }, deps)
    ).resolves.toEqual({ success: false, reason: 'ambiguous_integration' });
    expect(deps.credentialResolver.resolveCredential).not.toHaveBeenCalled();
  });

  it('resolves an absent pin by the authorized host and full nested path', async () => {
    const otherHost = {
      ...first,
      metadata: { gitlab_instance_url: 'https://other.example.com/gitlab' },
    };
    await expect(
      resolveGitLabRuntimeToken({ ...owner, repositoryUrl }, dependencies([otherHost, second]))
    ).resolves.toMatchObject({
      success: true,
      token: 'second-token',
      instanceUrl: 'https://gitlab.example.com/gitlab',
    });
  });

  it.each([{}, { expectedIntegrationId: second.integrationId }])(
    'resolves an authorized instance subpath with request fields %j',
    async pin => {
      const integration = {
        ...second,
        metadata: { gitlab_instance_url: 'https://gitlab.example.com/gitlab+enterprise' },
      };
      await expect(
        resolveGitLabRuntimeToken(
          {
            ...owner,
            ...pin,
            repositoryUrl: 'https://gitlab.example.com/gitlab+enterprise/acme/widgets.git',
          },
          dependencies([first, integration])
        )
      ).resolves.toMatchObject({
        success: true,
        token: 'second-token',
        integrationId: second.integrationId,
        instanceUrl: 'https://gitlab.example.com/gitlab+enterprise',
      });
    }
  );

  it.each([
    'https://gitlab.example.com/gitlab+enterprise/acme/wid+gets.git',
    'https://gitlab.example.com/gitlab+enterprise/acme/%2e%2e/widgets.git',
  ])('keeps invalid projects rejected below an authorized instance subpath: %s', async url => {
    await expect(
      resolveGitLabRuntimeToken(
        { ...owner, repositoryUrl: url },
        dependencies([
          {
            ...first,
            metadata: { gitlab_instance_url: 'https://gitlab.example.com/gitlab+enterprise' },
          },
        ])
      )
    ).resolves.toEqual({ success: false, reason: 'invalid_repository_url' });
  });

  it.each([{}, { expectedIntegrationId: first.integrationId }])(
    'preserves invalid URL error precedence over failed authorization: %j',
    async pin => {
      await expect(
        resolveGitLabRuntimeToken(
          { ...owner, ...pin, repositoryUrl: 'not-a-url' },
          dependencies([])
        )
      ).resolves.toEqual({ success: false, reason: 'invalid_repository_url' });
    }
  );

  it('rejects ambiguous old-form identity under an authorized instance subpath', async () => {
    const metadata = { gitlab_instance_url: 'https://gitlab.example.com/gitlab+enterprise' };
    await expect(
      resolveGitLabRuntimeToken(
        {
          ...owner,
          repositoryUrl: 'https://gitlab.example.com/gitlab+enterprise/acme/widgets.git',
        },
        dependencies([
          { ...first, metadata },
          { ...second, metadata },
        ])
      )
    ).resolves.toEqual({ success: false, reason: 'ambiguous_integration' });
  });

  it.each([
    { userId: 'wrong-personal-owner' },
    { ...owner, orgId: '123e4567-e89b-12d3-a456-426614174030' },
  ])('retains owner authorization with a pin: %j', async actor => {
    const deps = dependencies();
    await expect(
      resolveGitLabRuntimeToken({ ...actor, expectedIntegrationId: first.integrationId }, deps)
    ).resolves.toEqual(notFound);
    expect(deps.credentialResolver.resolveCredential).not.toHaveBeenCalled();
  });

  it('does not substitute a different integration when the pinned integration is inactive', async () => {
    const deps = dependencies([second]);
    await expect(
      resolveGitLabRuntimeToken({ ...owner, expectedIntegrationId: first.integrationId }, deps)
    ).resolves.toEqual(notFound);
    expect(deps.credentialResolver.resolveCredential).not.toHaveBeenCalled();
  });

  it.each([
    'https://other.example.com/gitlab/acme/nested/widgets.git',
    'https://gitlab.example.com/gitlab-other/acme/nested/widgets.git',
  ])('rejects a pinned host or subpath collision: %s', async url => {
    const deps = dependencies();
    await expect(
      resolveGitLabRuntimeToken(
        { ...owner, repositoryUrl: url, expectedIntegrationId: first.integrationId },
        deps
      )
    ).resolves.toEqual({ success: false, reason: 'no_matching_integration' });
    expect(deps.credentialResolver.resolveCredential).not.toHaveBeenCalled();
  });

  it('preserves temporary credential failures instead of treating them as an empty authorization', async () => {
    const deps = dependencies();
    deps.credentialResolver.resolveCredential.mockResolvedValueOnce({
      status: 'temporarily_unavailable',
    });
    await expect(resolveGitLabRuntimeToken(owner, deps)).resolves.toEqual({
      success: false,
      reason: 'token_refresh_failed',
    });
  });

  it.each(['https://gitlab.example.com', 'https://other.example.com/gitlab'])(
    'rejects credential instance rebinding to %s',
    async instanceUrl => {
      const deps = dependencies();
      deps.credentialResolver.resolveCredential.mockResolvedValueOnce({
        status: 'available',
        token: 'foreign-token',
        integrationId: first.integrationId,
        instanceUrl,
        glabIsOAuth2: true,
        source: { type: 'integration' },
      });
      await expect(
        resolveGitLabRuntimeToken(
          { ...owner, repositoryUrl, expectedIntegrationId: first.integrationId },
          deps
        )
      ).resolves.toEqual({ success: false, reason: 'no_matching_integration' });
    }
  );

  it('does not select a legacy project token while another candidate remains unresolved', async () => {
    const deps = dependencies([first, second]);
    deps.credentialResolver.resolveCredential.mockResolvedValueOnce({
      status: 'temporarily_unavailable',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => Response.json({ id: 73 }))
    );
    await expect(
      resolveGitLabRuntimeToken({ ...owner, repositoryUrl, createdOnPlatform: 'code-review' }, deps)
    ).resolves.toEqual({ success: false, reason: 'token_refresh_failed' });
  });

  it('keeps no authorized integration distinct from credential failure', async () => {
    await expect(resolveGitLabRuntimeToken(owner, dependencies([]))).resolves.toEqual(notFound);
  });

  it('pins project-token resolution without evaluating a different authorized integration', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json({ id: 73 }));
    vi.stubGlobal('fetch', fetch);
    await expect(
      resolveGitLabRuntimeToken(
        {
          ...owner,
          repositoryUrl,
          createdOnPlatform: 'code-review',
          expectedIntegrationId: second.integrationId,
        },
        dependencies([first, second])
      )
    ).resolves.toMatchObject({
      success: true,
      token: 'second-token',
      integrationId: second.integrationId,
      source: { type: 'project', projectId: 73 },
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps ambiguous legacy project credentials rejected', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async () => Response.json({ id: 73 }))
    );
    await expect(
      resolveGitLabRuntimeToken(
        { ...owner, repositoryUrl, createdOnPlatform: 'code-review' },
        dependencies([first, second])
      )
    ).resolves.toEqual({ success: false, reason: 'ambiguous_integration' });
  });
});
