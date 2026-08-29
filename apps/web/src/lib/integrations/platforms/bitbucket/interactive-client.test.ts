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
import {
  createBitbucketInteractiveClient,
  type BitbucketInteractiveRequest,
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
const json = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('server-only Bitbucket interactive broker client', () => {
  it('sends exact identity to the Worker and returns no credential objects', async () => {
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
        return json({ success: true, result: { status: 201, data: { id: 91 } } }, 200, {
          authorization: 'internal-token-fixture',
        });
      },
    }).execute(request);
    expect(sent).toEqual([
      {
        url: 'https://token-service.example/internal/bitbucket/interactive-review',
        body: { ...options.workspace, ...options.repository, request },
        redirect: 'manual',
      },
    ]);
    expect(result).toEqual({ status: 201, data: { id: 91 } });
    expect(JSON.stringify(result)).not.toContain('internal-token-fixture');
  });

  it.each([
    { status: 200, data: { values: [] } },
    {
      status: 202,
      data: null,
      location:
        'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/7/merge/task-status/task-1',
    },
    { status: 204, data: null },
  ])('preserves the broker status variant %#', async result => {
    await expect(
      createBitbucketInteractiveClient({
        ...options,
        fetch: async () => json({ success: true, result }),
      }).execute(request)
    ).resolves.toEqual(result);
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
        return json({ success: true, result: { status: 201, data: { id: 91 } } });
      },
    });
    await expect(
      client.execute({ ...empty, body: { ...empty.body, content: { raw } } })
    ).resolves.toEqual({ status: 201, data: { id: 91 } });
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
          success: true,
          result: { status: 201, data: { id: 91, content: received.request.body.content } },
        });
      },
    }).execute({ ...request, body: { ...request.body, content: { raw } } });
    expect(result).toEqual({ status: 201, data: { id: 91, content: { raw } } });
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
