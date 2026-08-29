jest.mock('@/lib/config.server', () => ({
  GIT_TOKEN_SERVICE_API_URL: 'https://token-service.example',
}));
jest.mock('@/lib/tokens', () => ({
  generateInternalServiceToken: (
    userId: string,
    claims: { organizationId?: string; audience?: string }
  ) =>
    userId === 'kilo-user' &&
    claims.organizationId === 'kilo-org' &&
    claims.audience === 'git-token-service:bitbucket-interactive-review'
      ? 'internal-token-fixture'
      : 'wrong-claims',
  TOKEN_EXPIRY: { fiveMinutes: '5m' },
}));

import { describe, expect, it } from '@jest/globals';
import type { ReviewActor } from '@kilocode/app-shared/provider-review';
import {
  createBitbucketInteractiveClient,
  type BitbucketInteractiveMetadata,
  type BitbucketInteractiveRequest,
  type BitbucketInteractiveServiceSuccess,
} from './interactive-client';

const options = {
  actorUserId: 'kilo-user',
  organizationId: 'kilo-org',
  workspace: {
    integrationId: 'integration-1',
    workspaceUuid: 'a07d5c40-2d2d-4e79-a812-6a47824a77d6',
    workspaceSlug: 'acme',
  },
  repository: {
    repositoryUuid: '38a47a32-cb87-4a9f-b75d-7224774bba77',
    repositoryFullName: 'acme/widgets',
  },
};
const request = {
  operation: 'createComment',
  params: { path: { workspace: 'acme', repo_slug: 'widgets', pull_request_id: 7 } },
  body: { type: 'pullrequest_comment', content: { raw: 'Review text' } },
} satisfies BitbucketInteractiveRequest<'createComment'>;
const oauthActor = {
  credentialKind: 'bitbucketOAuth',
  actor: {
    provider: 'bitbucket',
    instanceUrl: 'https://bitbucket.org',
    id: 'provider-user-42',
    displayName: 'Provider User',
    login: 'provider-user',
    avatarUrl: null,
  },
} satisfies BitbucketInteractiveMetadata['providerActor'];
const metadata = {
  actorUserId: options.actorUserId,
  organizationId: options.organizationId,
  integrationId: options.workspace.integrationId,
  instanceUrl: 'https://bitbucket.org',
  providerActor: {
    credentialKind: 'bitbucketWorkspaceToken',
    workspaceUuid: options.workspace.workspaceUuid,
    workspaceSlug: options.workspace.workspaceSlug,
  },
  grants: { scopes: ['repository', 'repository:write', 'pullrequest'] },
} satisfies BitbucketInteractiveMetadata;
const success = {
  success: true,
  result: { status: 201, data: { id: 91 } },
  metadata,
} satisfies BitbucketInteractiveServiceSuccess;
const json = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('server-only Bitbucket interactive broker client', () => {
  it('sends exact identity and exposes workspace-token facts without credential objects', async () => {
    const sent: { url: string; body: unknown; redirect?: RequestRedirect }[] = [];
    const result = await createBitbucketInteractiveClient({
      ...options,
      fetch: async (url, init) => {
        if (new Headers(init?.headers).get('authorization') !== 'Bearer internal-token-fixture')
          return json({}, 403);
        sent.push({
          url: String(url),
          body: JSON.parse(String(init?.body)),
          redirect: init?.redirect,
        });
        return json(success, 200, { authorization: 'internal-token-fixture' });
      },
    }).execute(request);
    expect(sent).toEqual([
      {
        url: 'https://token-service.example/internal/bitbucket/interactive-review',
        body: { ...options.workspace, ...options.repository, request },
        redirect: 'manual',
      },
    ]);
    expect(result).toEqual({ status: 201, data: { id: 91 }, metadata });
    const principal = result.metadata.providerActor;
    expect(
      principal.credentialKind === 'bitbucketWorkspaceToken' ? principal.workspaceUuid : null
    ).toBe(options.workspace.workspaceUuid);
    expect(JSON.stringify(result)).not.toContain('internal-token-fixture');
  });

  it('exposes the shared OAuth actor and explicit write grant beside typed provider data', async () => {
    const result = await createBitbucketInteractiveClient({
      ...options,
      fetch: async () =>
        json({
          ...success,
          metadata: {
            ...metadata,
            providerActor: oauthActor,
            grants: { scopes: ['repository:write', 'pullrequest', 'pullrequest:write'] },
          },
        }),
    }).execute(request);
    if (result.status !== 201) throw new Error('Expected a created comment');
    const principal = result.metadata.providerActor;
    if (principal.credentialKind !== 'bitbucketOAuth') throw new Error('Expected an OAuth actor');
    const actor: ReviewActor = principal.actor;
    expect({
      commentId: result.data.id,
      kiloActor: result.metadata.actorUserId,
      organization: result.metadata.organizationId,
      integration: result.metadata.integrationId,
      instance: result.metadata.instanceUrl,
      providerActor: actor.id,
      providerLogin: actor.login,
      scopes: result.metadata.grants.scopes,
    }).toEqual({
      commentId: 91,
      kiloActor: 'kilo-user',
      organization: 'kilo-org',
      integration: 'integration-1',
      instance: 'https://bitbucket.org',
      providerActor: 'provider-user-42',
      providerLogin: 'provider-user',
      scopes: ['repository:write', 'pullrequest', 'pullrequest:write'],
    });
  });

  it.each([
    { status: 200, data: { values: [] } },
    { status: 200, data: '' },
    { status: 201, data: { id: 91 } },
    {
      status: 202,
      data: null,
      location:
        'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/7/merge/task-status/task-1',
    },
    { status: 204, data: null },
  ])('preserves the broker status variant and metadata %#', async result => {
    await expect(
      createBitbucketInteractiveClient({
        ...options,
        fetch: async () => json({ ...success, result }),
      }).execute(request)
    ).resolves.toEqual({ ...result, metadata });
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['empty', {}],
    ['Kilo actor', { ...metadata, actorUserId: undefined }],
    ['organization', { ...metadata, organizationId: '' }],
    ['integration', { ...metadata, integrationId: null }],
    ['instance', { ...metadata, instanceUrl: 'https://other.example' }],
    ['principal', { ...metadata, providerActor: undefined }],
    [
      'workspace UUID',
      { ...metadata, providerActor: { ...metadata.providerActor, workspaceUuid: 'not-a-uuid' } },
    ],
    [
      'workspace slug',
      { ...metadata, providerActor: { ...metadata.providerActor, workspaceSlug: '' } },
    ],
    [
      'workspace token presented as an OAuth user',
      {
        ...metadata,
        providerActor: { ...metadata.providerActor, credentialKind: 'bitbucketOAuth' },
      },
    ],
    [
      'OAuth user presented as a workspace token',
      { ...metadata, providerActor: { ...oauthActor, credentialKind: 'bitbucketWorkspaceToken' } },
    ],
    ['OAuth actor', { ...metadata, providerActor: { ...oauthActor, actor: null } }],
    [
      'OAuth provider',
      {
        ...metadata,
        providerActor: { ...oauthActor, actor: { ...oauthActor.actor, provider: 'gitlab' } },
      },
    ],
    [
      'OAuth instance',
      {
        ...metadata,
        providerActor: {
          ...oauthActor,
          actor: { ...oauthActor.actor, instanceUrl: 'https://other.example' },
        },
      },
    ],
    ['grants', { ...metadata, grants: undefined }],
    ['scope list', { ...metadata, grants: { scopes: 'pullrequest' } }],
    [
      'unknown scope',
      { ...metadata, grants: { scopes: ['pullrequest', 'provider-token-fixture'] } },
    ],
  ])('fails closed for missing or malformed metadata: %s', async (_name, invalidMetadata) => {
    await expect(
      createBitbucketInteractiveClient({
        ...options,
        fetch: async () => json({ ...success, metadata: invalidMetadata }),
      }).execute(request)
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  const providerCredential = 'provider-token-fixture';
  it.each([
    ['envelope', { ...success, access_token: providerCredential }],
    ['result', { ...success, result: { ...success.result, authorization: providerCredential } }],
    ['metadata', { ...success, metadata: { ...metadata, accessToken: providerCredential } }],
    [
      'workspace principal',
      {
        ...success,
        metadata: {
          ...metadata,
          providerActor: { ...metadata.providerActor, token: providerCredential },
        },
      },
    ],
    [
      'OAuth principal',
      {
        ...success,
        metadata: { ...metadata, providerActor: { ...oauthActor, credential: providerCredential } },
      },
    ],
    [
      'OAuth actor',
      {
        ...success,
        metadata: {
          ...metadata,
          providerActor: {
            ...oauthActor,
            actor: { ...oauthActor.actor, access_token: providerCredential },
          },
        },
      },
    ],
    [
      'grants',
      {
        ...success,
        metadata: { ...metadata, grants: { ...metadata.grants, refreshToken: providerCredential } },
      },
    ],
  ])('rejects credential extras in the %s without leaking or replaying', async (_name, payload) => {
    let writes = 0;
    const error = await createBitbucketInteractiveClient({
      ...options,
      fetch: async () => {
        writes += 1;
        return json(payload);
      },
    })
      .execute(request)
      .catch(error => error);
    expect(error).toMatchObject({ code: 'invalid_response' });
    expect(`${String(error)} ${JSON.stringify(error)} ${error.stack}`).not.toContain(
      providerCredential
    );
    expect(writes).toBe(1);
  });

  it.each([
    { status: 202, data: null },
    { status: 204, data: { id: 91 } },
    { status: 201 },
    { status: 205, data: null },
  ])('rejects malformed provider results even with valid metadata %#', async result => {
    await expect(
      createBitbucketInteractiveClient({
        ...options,
        fetch: async () => json({ ...success, result }),
      }).execute(request)
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([
    'reconnect_required',
    'insufficient_permissions',
    'conflict',
    'rate_limited',
    'temporarily_unavailable',
    'authentication_rejected',
    'provider_unavailable',
    'request_failed',
    'invalid_pagination',
    'page_limit_exceeded',
    'item_limit_exceeded',
  ] as const)('keeps %s distinct without retrying writes', async reason => {
    let writes = 0;
    await expect(
      createBitbucketInteractiveClient({
        ...options,
        fetch: async () => {
          writes += 1;
          return json({ success: false, reason });
        },
      }).execute(request)
    ).rejects.toMatchObject({ code: reason });
    expect(writes).toBe(1);
  });

  it('rejects Personal context before a broker call', async () => {
    let writes = 0;
    await expect(
      createBitbucketInteractiveClient({
        ...options,
        organizationId: '',
        fetch: async () => {
          writes += 1;
          return json({});
        },
      }).execute(request)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(writes).toBe(0);
  });

  it('bounds the complete UTF-8 envelope before a broker call', async () => {
    let writes = 0;
    await expect(
      createBitbucketInteractiveClient({
        ...options,
        fetch: async () => {
          writes += 1;
          return json({});
        },
      }).execute({ ...request, body: { ...request.body, content: { raw: '雪'.repeat(90_000) } } })
    ).rejects.toMatchObject({ code: 'request_too_large' });
    expect(writes).toBe(0);
  });

  it('counts identity and JSON escaping at the exact request ceiling', async () => {
    const empty = { ...request, body: { ...request.body, content: { raw: '' } } };
    const overhead = new TextEncoder().encode(
      JSON.stringify({ ...options.workspace, ...options.repository, request: empty })
    ).byteLength;
    const raw = 'x'.repeat(256_000 - overhead);
    let writes = 0;
    const client = createBitbucketInteractiveClient({
      ...options,
      fetch: async () => {
        writes += 1;
        return json(success);
      },
    });
    await expect(
      client.execute({ ...empty, body: { ...empty.body, content: { raw } } })
    ).resolves.toEqual({ status: 201, data: { id: 91 }, metadata });
    await expect(
      client.execute({ ...empty, body: { ...empty.body, content: { raw: `${raw}\n` } } })
    ).rejects.toMatchObject({ code: 'request_too_large' });
    expect(writes).toBe(1);
  });

  it('preserves long text within the interactive envelope', async () => {
    const raw = '雪'.repeat(65_536);
    const result = await createBitbucketInteractiveClient({
      ...options,
      fetch: async (_url, init) => {
        const received = JSON.parse(String(init?.body));
        return json({
          ...success,
          result: { status: 201, data: { id: 91, content: received.request.body.content } },
        });
      },
    }).execute({ ...request, body: { ...request.body, content: { raw } } });
    expect(result).toEqual({ status: 201, data: { id: 91, content: { raw } }, metadata });
  });

  it.each(['redirect', 'address', 'size', 'media', 'schema', 'json', 'lost'] as const)(
    'redacts %s failures and never repeats the write',
    async kind => {
      let writes = 0;
      const error = await createBitbucketInteractiveClient({
        ...options,
        fetch: async () => {
          writes += 1;
          if (kind === 'lost')
            throw Object.assign(new Error('internal-token-fixture'), {
              response: { authorization: 'internal-token-fixture' },
            });
          if (kind === 'redirect')
            return new Response(null, {
              status: 307,
              headers: { location: 'https://evil.example' },
            });
          if (kind === 'size') return json({}, 200, { 'content-length': '1000001' });
          if (kind === 'media') return new Response('internal-token-fixture');
          if (kind === 'json')
            return new Response('internal-token-fixture', {
              headers: { 'content-type': 'application/json' },
            });
          const response = json({
            success: false,
            reason: 'internal-token-fixture',
            request: { authorization: 'internal-token-fixture' },
          });
          if (kind === 'address')
            Object.defineProperty(response, 'url', { value: 'https://evil.example' });
          return response;
        },
      })
        .execute(request)
        .catch(error => error);
      expect(error.code).toBe(
        kind === 'redirect' || kind === 'address'
          ? 'redirect_rejected'
          : kind === 'size'
            ? 'response_too_large'
            : kind === 'lost'
              ? 'temporarily_unavailable'
              : 'invalid_response'
      );
      expect(writes).toBe(1);
      expect(`${String(error)} ${JSON.stringify(error)} ${error.stack}`).not.toContain(
        'internal-token-fixture'
      );
      expect(error).not.toHaveProperty('request');
      expect(error).not.toHaveProperty('response');
      expect(error).not.toHaveProperty('cause');
    }
  );
});
