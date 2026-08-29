import { describe, expect, it } from 'vitest';
import {
  BitbucketInteractiveMetadataSchema,
  createBitbucketInteractiveApi,
  type BitbucketInteractiveData,
  type BitbucketInteractiveMetadata,
  type BitbucketInteractiveRequest,
} from './bitbucket-interactive-api.js';

const token = 'private-provider-token';
const params = { path: { workspace: 'acme', repo_slug: 'widgets', pull_request_id: 7 } };
const prUrl = 'https://api.bitbucket.org/2.0/repositories/acme/widgets/pullrequests/7';
const taskUrl = `${prUrl}/merge/task-status/task-1`;
const get = {
  operation: 'pullRequest',
  params,
} satisfies BitbucketInteractiveRequest<'pullRequest'>;
const comment = {
  operation: 'createComment',
  params,
  body: { type: 'pullrequest_comment', content: { raw: 'Review text' } },
} satisfies BitbucketInteractiveRequest<'createComment'>;
const merge = {
  operation: 'merge',
  params,
  body: { type: 'pullrequest_merge_parameters', merge_strategy: 'merge_commit' },
} satisfies BitbucketInteractiveRequest<'merge'>;
const branches = {
  operation: 'branches',
  params: { path: { workspace: 'acme', repo_slug: 'widgets' } },
} satisfies BitbucketInteractiveRequest<'branches'>;
const json = (body: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
function api(fetch: typeof globalThis.fetch) {
  return createBitbucketInteractiveApi({
    scope: { kind: 'repository', workspace: 'acme', repository: 'widgets' },
    accessToken: token,
    fetch,
  });
}

describe('Bitbucket broker metadata contract', () => {
  it.each([
    {
      credentialKind: 'bitbucketOAuth',
      actor: {
        provider: 'bitbucket',
        instanceUrl: 'https://bitbucket.org',
        id: 'provider-user-42',
        displayName: null,
        login: 'provider-user',
        avatarUrl: null,
      },
    },
    {
      credentialKind: 'bitbucketWorkspaceToken',
      workspaceUuid: '{a07d5c40-2d2d-4e79-a812-6a47824a77d6}',
      workspaceSlug: 'acme',
    },
  ] satisfies BitbucketInteractiveMetadata['providerActor'][])(
    'retains $credentialKind identity without adding a write grant',
    providerActor => {
      const metadata = {
        actorUserId: 'oauth/kilo-user',
        organizationId: 'kilo-org',
        integrationId: 'integration-1',
        instanceUrl: 'https://bitbucket.org',
        providerActor,
        grants: { scopes: ['repository:write', 'pullrequest'] },
      } satisfies BitbucketInteractiveMetadata;
      expect(BitbucketInteractiveMetadataSchema.parse(metadata)).toEqual(metadata);
    }
  );
});

describe('Bitbucket generated SDK boundary', () => {
  it('preserves JSON data and status without SDK or credential-bearing objects', async () => {
    const result = await api(async () =>
      json({ id: 7, state: 'OPEN' }, 200, { authorization: token, 'set-cookie': token })
    ).execute(get);
    expect(result).toEqual({ status: 200, data: { id: 7, state: 'OPEN' } });
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('serializes the generated comment body once and preserves a 201 result', async () => {
    let effects = 0;
    let destination = '';
    const result = await api(async (url, init) => {
      effects += 1;
      destination = url instanceof Request ? url.url : url.toString();
      expect(init?.redirect).toBe('manual');
      expect(init?.method).toBe('POST');
      return json({ id: 91, content: JSON.parse(init?.body as string).content }, 201, {
        location: `${prUrl}/comments/91`,
      });
    }).execute(comment);
    expect(result).toEqual({
      status: 201,
      data: { id: 91, content: { raw: 'Review text' } },
      location: `${prUrl}/comments/91`,
    });
    expect(destination).toBe(`${prUrl}/comments`);
    expect(effects).toBe(1);
  });

  it.each(['header', 'body'])('keeps a 202 %s task pending, not confirmed', async kind => {
    const result = await api(async () =>
      kind === 'header'
        ? new Response(null, { status: 202, headers: { location: taskUrl } })
        : json({ task_status_url: taskUrl }, 202, { location: taskUrl })
    ).execute(merge);
    expect(result).toEqual({
      status: 202,
      location: taskUrl,
      data: kind === 'header' ? null : { task_status_url: taskUrl },
    });
  });

  it.each([
    {
      request: { operation: 'approve', params },
      method: 'POST',
      url: `${prUrl}/approve`,
      status: 200,
    },
    {
      request: { operation: 'requestChanges', params },
      method: 'POST',
      url: `${prUrl}/request-changes`,
      status: 200,
    },
    {
      request: {
        operation: 'resolveComment',
        params: { path: { ...params.path, comment_id: 91 } },
      },
      method: 'POST',
      url: `${prUrl}/comments/91/resolve`,
      status: 200,
    },
    {
      request: { operation: 'reopenComment', params: { path: { ...params.path, comment_id: 91 } } },
      method: 'DELETE',
      url: `${prUrl}/comments/91/resolve`,
      status: 204,
    },
    {
      request: {
        operation: 'updateComment',
        params: { path: { ...params.path, comment_id: 91 } },
        body: comment.body,
      },
      method: 'PUT',
      url: `${prUrl}/comments/91`,
      status: 200,
    },
    {
      request: { operation: 'deleteComment', params: { path: { ...params.path, comment_id: 91 } } },
      method: 'DELETE',
      url: `${prUrl}/comments/91`,
      status: 204,
    },
    {
      request: {
        operation: 'deleteBranch',
        params: { path: { ...branches.params.path, name: 'topic/work' } },
      },
      method: 'DELETE',
      url: 'https://api.bitbucket.org/2.0/repositories/acme/widgets/refs/branches/topic%2Fwork',
      status: 204,
    },
  ] satisfies {
    request: BitbucketInteractiveRequest;
    method: string;
    url: string;
    status: number;
  }[])('dispatches the supported mutation to its exact endpoint %#', async fixture => {
    const result = await api(async (url, init) => {
      if (url !== fixture.url || init?.method !== fixture.method) return json({}, 405);
      return fixture.status === 204
        ? new Response(null, { status: 204 })
        : json({ id: 91 }, fixture.status);
    }).execute(fixture.request);
    expect(result).toEqual({
      status: fixture.status,
      data: fixture.status === 204 ? null : { id: 91 },
    });
  });

  it('returns the task status without turning provider success into another merge', async () => {
    const result = await api(async () =>
      json({ task_status: 'SUCCESS', merge_result: { id: 7, state: 'MERGED' } })
    ).execute({ operation: 'mergeTask', params: { path: { ...params.path, task_id: 'task-1' } } });
    expect(result).toEqual({
      status: 200,
      data: { task_status: 'SUCCESS', merge_result: { id: 7, state: 'MERGED' } },
    });
  });

  it.each(['unapprove', 'removeChangeRequest'] as const)(
    'keeps %s 204 success bodyless',
    async operation => {
      await expect(
        api(async () => new Response(null, { status: 204 })).execute({ operation, params })
      ).resolves.toEqual({ status: 204, data: null });
    }
  );

  it.each([
    'https://evil.example/task',
    `${prUrl.replace('/7', '/8')}/merge/task-status/task-1`,
    `${prUrl}/merge/task-status/`,
  ])('rejects a foreign or empty accepted task %s', async location => {
    await expect(
      api(async () => new Response(null, { status: 202, headers: { location } })).execute(merge)
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('does not report acceptance without a task identity', async () => {
    await expect(
      api(async () => new Response(null, { status: 202 })).execute(merge)
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it.each([401, 403, 409, 429, 503, 'lost'] as const)(
    'does not retry a write after %s',
    async status => {
      let effects = 0;
      const error = await api(async () => {
        effects += 1;
        if (status === 'lost')
          throw Object.assign(new Error(token), { request: { authorization: token } });
        return json({ error: { message: token } }, status);
      })
        .execute(comment)
        .catch(error => error);
      expect(error.code).toBe(
        status === 401
          ? 'authentication_rejected'
          : status === 403
            ? 'insufficient_permissions'
            : status === 409
              ? 'conflict'
              : status === 429
                ? 'rate_limited'
                : status === 503
                  ? 'provider_unavailable'
                  : 'transport_failed'
      );
      expect(effects).toBe(1);
      expect(`${String(error)} ${error.stack} ${JSON.stringify(error)}`).not.toContain(token);
      expect(error).not.toHaveProperty('request');
      expect(error).not.toHaveProperty('response');
      expect(error).not.toHaveProperty('cause');
    }
  );

  it.each([302, 307])('rejects SDK redirects (%s) without replaying the write', async status => {
    let effects = 0;
    await expect(
      api(async () => {
        effects += 1;
        return new Response(null, { status, headers: { location: taskUrl } });
      }).execute(merge)
    ).rejects.toMatchObject({ code: 'redirect_rejected' });
    expect(effects).toBe(1);
  });

  it('rejects SDK response address substitution', async () => {
    const response = json({ id: 7 });
    Object.defineProperty(response, 'url', { value: 'https://evil.example' });
    await expect(api(async () => response).execute(get)).rejects.toMatchObject({
      code: 'redirect_rejected',
    });
  });

  it.each([
    { ...get, params: { path: { ...params.path, workspace: 'other' } } },
    { ...get, params: { path: { ...params.path, repo_slug: 'other' } } },
    { ...get, params: { path: { ...params.path, pull_request_id: '../8' } } },
    { ...get, params: { path: { ...params.path, pull_request_id: 'activity' } } },
    { ...get, params: { path: { ...params.path, pull_request_id: Number.MAX_SAFE_INTEGER + 1 } } },
    { ...get, baseUrl: 'https://evil.example' },
    { ...get, operation: 'deleteRepository' },
  ])('rejects operation or resource substitution before dispatch %#', async request => {
    let effects = 0;
    await expect(
      api(async () => {
        effects += 1;
        return json({ id: 7 });
      }).execute(request as BitbucketInteractiveRequest<'pullRequest'>)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(effects).toBe(0);
  });

  it.each([
    { ...comment, body: null },
    { ...comment, body: undefined },
    { operation: 'approve', params, body: { expected_head: 'not-an-atomic-guard' } },
  ])('rejects invalid mutation envelopes before dispatch %#', async (request: object) => {
    let effects = 0;
    await expect(
      api(async () => {
        effects += 1;
        return json({ id: 91 }, 201);
      }).execute(request as BitbucketInteractiveRequest)
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(effects).toBe(0);
  });

  it('rejects an oversized serialized request before any provider effect', async () => {
    let effects = 0;
    await expect(
      api(async () => {
        effects += 1;
        return json({ id: 91 }, 201);
      }).execute({ ...comment, body: { ...comment.body, content: { raw: '雪'.repeat(90_000) } } })
    ).rejects.toMatchObject({ code: 'request_too_large' });
    expect(effects).toBe(0);
  });

  it('preserves long review text that fits the serialized envelope', async () => {
    const raw = '雪'.repeat(65_536);
    const result = await api(async (_url, init) =>
      json({ id: 91, content: JSON.parse(init?.body as string).content }, 201)
    ).execute({ ...comment, body: { ...comment.body, content: { raw } } });
    expect(result).toEqual({ status: 201, data: { id: 91, content: { raw } } });
  });

  it.each(['text', 'stream'] as const)('returns bounded %s diffs', async representation => {
    const diff = 'diff --git a/file.ts b/file.ts\n-old\n+new\n';
    const request = {
      operation: 'diff',
      params: { path: { workspace: 'acme', repo_slug: 'widgets', spec: 'aaaaaaa..bbbbbbb' } },
    } satisfies BitbucketInteractiveRequest<'diff'>;
    const client = api(
      async () => new Response(diff, { headers: { 'content-type': 'text/x-diff' } })
    );
    const result =
      representation === 'stream' ? await client.stream(request) : await client.execute(request);
    expect(result.status).toBe(200);
    expect(
      result.data instanceof ReadableStream ? await new Response(result.data).text() : result.data
    ).toBe(diff);
  });

  it.each(['text', 'stream'] as const)('keeps empty %s diffs readable', async mode => {
    const request = {
      operation: 'diff',
      params: { path: { ...branches.params.path, spec: 'aaaaaaa..bbbbbbb' } },
    } satisfies BitbucketInteractiveRequest<'diff'>;
    const client = api(async () => new Response('', { headers: { 'content-type': 'text/plain' } }));
    if (mode === 'stream') {
      const result = await client.stream(request);
      const reader = (result.data as ReadableStream<Uint8Array>).getReader();
      expect(await reader.read()).toEqual({ done: true, value: undefined });
      reader.releaseLock();
    } else {
      await expect(client.execute(request)).resolves.toEqual({ status: 200, data: '' });
    }
  });

  it('does not confuse a branch named raw with a text endpoint', async () => {
    await expect(
      api(async () => json({ name: 'raw' })).execute({
        operation: 'branch',
        params: { path: { ...branches.params.path, name: 'raw' } },
      })
    ).resolves.toEqual({ status: 200, data: { name: 'raw' } });
  });

  it.each(['text', 'stream'] as const)('rejects oversized %s diff data', async mode => {
    const request = {
      operation: 'diff',
      params: { path: { ...branches.params.path, spec: 'aaaaaaa..bbbbbbb' } },
    } satisfies BitbucketInteractiveRequest<'diff'>;
    const client = api(
      async () => new Response('x'.repeat(1_000_001), { headers: { 'content-type': 'text/plain' } })
    );
    await expect(
      mode === 'stream' ? client.stream(request) : client.execute(request)
    ).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it.each([
    [
      () => new Response('not JSON', { headers: { 'content-type': 'application/json' } }),
      'invalid_response',
    ],
    [() => json({ id: 7 }, 200, { 'content-type': 'text/html' }), 'invalid_response'],
    [() => json({ id: 7 }, 201), 'request_failed'],
  ] as const)('rejects malformed or undocumented success %#', async (response, code) => {
    await expect(api(async () => response()).execute(get)).rejects.toMatchObject({ code });
  });

  it('checks declared bounds even on an empty accepted task response', async () => {
    await expect(
      api(
        async () =>
          new Response(null, {
            status: 202,
            headers: { location: taskUrl, 'content-length': '1000001' },
          })
      ).execute(merge)
    ).rejects.toMatchObject({ code: 'response_too_large' });
  });

  it.each([
    { query: { kind: 'restrict_merges' }, expectedIds: [1, 3] },
    { query: { pattern: 'release/*' }, expectedIds: [1, 2] },
    { query: { kind: 'restrict_merges', pattern: 'release/*' }, expectedIds: [1] },
  ] satisfies {
    query: NonNullable<BitbucketInteractiveRequest<'restrictions'>['params']['query']>;
    expectedIds: number[];
  }[])(
    'returns restrictions matching the documented filters %#',
    async ({ query, expectedIds }) => {
      const restrictions = [
        { type: 'branchrestriction', id: 1, kind: 'restrict_merges', pattern: 'release/*' },
        { type: 'branchrestriction', id: 2, kind: 'push', pattern: 'release/*' },
        { type: 'branchrestriction', id: 3, kind: 'restrict_merges', pattern: 'main' },
      ];
      const result = await api(async url => {
        const endpoint = new URL(url instanceof Request ? url.url : url.toString());
        if (endpoint.pathname !== '/2.0/repositories/acme/widgets/branch-restrictions')
          return json({}, 404);
        const kind = endpoint.searchParams.get('kind');
        const pattern = endpoint.searchParams.get('pattern');
        return json({
          values: restrictions.filter(
            rule =>
              (kind === null || rule.kind === kind) &&
              (pattern === null || rule.pattern === pattern)
          ),
        });
      }).execute({ operation: 'restrictions', params: { path: branches.params.path, query } });
      expect(result.status === 200 ? result.data.values?.map(rule => rule.id) : undefined).toEqual(
        expectedIds
      );
    }
  );

  it.each([
    {
      data: {
        type: 'commit_file',
        path: 'image.png',
        attributes: ['binary', 'executable'],
        size: 900,
      },
      expected: { kind: 'file', binary: true, size: 900 },
    },
    {
      data: { type: 'commit_file', path: 'empty.txt', attributes: [], size: 0 },
      expected: { kind: 'file', binary: false, size: 0 },
    },
    {
      data: { type: 'commit_directory', path: 'src' },
      expected: { kind: 'directory' },
    },
  ] satisfies { data: BitbucketInteractiveData<'fileMetadata'>; expected: object }[])(
    'reads $data.type metadata without interpreting it as raw content %#',
    async ({ data, expected }) => {
      const commit = { type: 'commit', hash: 'aaaaaaa' };
      const result = await api(async url =>
        json(
          typeof url === 'string' && url.endsWith(`/${data.path}?format=meta`)
            ? { ...data, commit }
            : {}
        )
      ).execute({
        operation: 'fileMetadata',
        params: { path: { ...branches.params.path, commit: commit.hash, path: data.path } },
      });
      if (result.status !== 200) throw new Error('Expected metadata');
      const metadata: BitbucketInteractiveData<'fileMetadata'> = result.data;
      const details =
        metadata.type === 'commit_file'
          ? {
              kind: 'file',
              binary: metadata.attributes?.some(attribute => attribute === 'binary') ?? false,
              size: metadata.size,
            }
          : { kind: 'directory' };
      expect({ path: metadata.path, revision: metadata.commit?.hash, ...details }).toEqual({
        path: data.path,
        revision: commit.hash,
        ...expected,
      });
    }
  );

  it.each(['application/json', 'text/html', 'video/mp2t'])(
    'reads UTF-8 source with filename-derived type %s as text',
    async contentType => {
      await expect(
        api(
          async () =>
            new Response('{"name":"widgets"}', {
              headers: { 'content-type': contentType },
            })
        ).execute({
          operation: 'file',
          params: { path: { ...branches.params.path, commit: 'aaaaaaa', path: 'package.json' } },
        })
      ).resolves.toEqual({ status: 200, data: '{"name":"widgets"}' });
    }
  );

  it('rejects invalid UTF-8 source instead of replacing its bytes', async () => {
    await expect(
      api(
        async () =>
          new Response(new Uint8Array([0xff]), {
            headers: { 'content-type': 'application/octet-stream' },
          })
      ).execute({
        operation: 'file',
        params: { path: { ...branches.params.path, commit: 'aaaaaaa', path: 'file.bin' } },
      })
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('requires the documented Location header even when a task URL appears in JSON', async () => {
    await expect(
      api(async () => json({ task_status_url: taskUrl }, 202)).execute(merge)
    ).rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('redacts a failed task returned with HTTP 200', async () => {
    const error = await api(async () => json({ type: 'error', error: { message: token } }))
      .execute({
        operation: 'mergeTask',
        params: { path: { ...params.path, task_id: 'task-1' } },
      })
      .catch(error => error);
    expect(error).toMatchObject({ code: 'request_failed' });
    expect(`${String(error)} ${JSON.stringify(error)} ${error.stack}`).not.toContain(token);
  });

  it('keeps file context pinned to the supplied revision and nested path', async () => {
    const result = await api(
      async url =>
        new Response(
          url ===
            'https://api.bitbucket.org/2.0/repositories/acme/widgets/src/aaaaaaa/nested%2Ffile.ts'
            ? 'const value = 1;'
            : 'wrong-context',
          { headers: { 'content-type': 'application/octet-stream' } }
        )
    ).execute({
      operation: 'file',
      params: { path: { ...branches.params.path, commit: 'aaaaaaa', path: 'nested/file.ts' } },
    });
    expect(result).toEqual({ status: 200, data: 'const value = 1;' });
  });
});

describe('SDK credential boundary', () => {
  it.each(['access_token', 'oauth_token', 'Authorization', 'callback'])(
    'rejects credential or unknown query key %s before dispatch',
    async name => {
      const request: object = { ...get, params: { ...params, query: { [name]: token } } };
      let effects = 0;
      await expect(
        api(async () => {
          effects += 1;
          return json({ id: 7 });
        }).execute(request as BitbucketInteractiveRequest<'pullRequest'>)
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(effects).toBe(0);
    }
  );

  it.each(['access_token', 'oauth_token', 'Authorization', 'callback'])(
    'rejects credential or unknown key %s alongside restriction filters',
    async name => {
      let effects = 0;
      await expect(
        api(async () => {
          effects += 1;
          return json({ values: [] });
        }).execute({
          operation: 'restrictions',
          params: {
            path: branches.params.path,
            query: { kind: 'restrict_merges', pattern: 'release/*', [name]: token },
          },
        })
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(effects).toBe(0);
    }
  );

  it('rejects credential-bearing location queries without replaying a created comment', async () => {
    let effects = 0;
    const error = await api(async () => {
      effects += 1;
      return json({ id: 91 }, 201, { location: `${prUrl}/comments/91?access_token=${token}` });
    })
      .execute(comment)
      .catch(error => error);
    expect(error).toMatchObject({ code: 'invalid_response' });
    expect(`${String(error)} ${JSON.stringify(error)} ${error.stack}`).not.toContain(token);
    expect(effects).toBe(1);
  });
});

describe('bounded SDK pagination', () => {
  const url = 'https://api.bitbucket.org/2.0/repositories/acme/widgets/refs/branches?pagelen=50';
  it('keeps empty data distinct from errors', async () => {
    await expect(api(async () => json({ values: [] })).execute(branches)).resolves.toEqual({
      status: 200,
      data: { values: [] },
    });
  });
  it('follows an opaque next link only within the same resource and query', async () => {
    const next = `${url}&cursor=opaque%2Fvalue`;
    let count = 0;
    const pages = [];
    for await (const result of api(async destination => {
      count += 1;
      return count === 1
        ? json({ values: [{ name: 'trunk' }], next })
        : json({ values: [{ name: destination === next ? 'topic' : 'wrong-resource' }] });
    }).pages(branches))
      pages.push(result.data);
    expect(pages).toEqual([{ values: [{ name: 'trunk' }], next }, { values: [{ name: 'topic' }] }]);
  });
  it.each([
    url.replace('api.bitbucket.org', 'evil.example'),
    url.replace('/widgets/', '/other/'),
    `${url}&q=changed`,
    `${url}&pagelen=100`,
    `${url}&page=101`,
    `${url}#fragment`,
  ])('rejects an unbound next link %s', async next => {
    await expect(
      api(async () => json({ values: [], next })).execute(branches)
    ).rejects.toMatchObject({ code: 'invalid_pagination' });
  });
  it('bounds traversal even when opaque cursors never repeat', async () => {
    let pages = 0;
    const client = api(async () => json({ values: [], next: `${url}&cursor=${++pages}` }));
    await expect(
      (async () => {
        for await (const page of client.pages(branches)) expect(page.status).toBe(200);
      })()
    ).rejects.toMatchObject({ code: 'page_limit_exceeded' });
    expect(pages).toBe(100);
  });
  it('stops at 5,000 items when the provider advertises more', async () => {
    let pages = 0;
    const client = api(async () =>
      json({
        values: Array.from({ length: 50 }, () => ({ name: 'branch' })),
        next: `${url}&cursor=${++pages}`,
      })
    );
    await expect(
      (async () => {
        for await (const page of client.pages(branches)) expect(page.status).toBe(200);
      })()
    ).rejects.toMatchObject({ code: 'item_limit_exceeded' });
    expect(pages).toBe(100);
  });

  it('bounds aggregate response bytes before yielding another page', async () => {
    let requests = 0;
    let yielded = 0;
    const client = api(async () =>
      json({
        values: [{ name: 'trunk', target: { message: 'x'.repeat(600_000) } }],
        next: `${url}&cursor=${++requests}`,
      })
    );
    await expect(
      (async () => {
        for await (const page of client.pages(branches)) {
          expect(page.status).toBe(200);
          yielded += 1;
        }
      })()
    ).rejects.toMatchObject({ code: 'response_too_large' });
    expect({ requests, yielded }).toEqual({ requests: 2, yielded: 1 });
  });

  it('rejects malformed pagination operations before a provider request', async () => {
    const request: object = { ...branches, operation: 'not-allowed' };
    let requests = 0;
    const client = api(async () => {
      requests += 1;
      return json({ values: [] });
    });
    await expect(
      client.pages(request as BitbucketInteractiveRequest<'branches'>).next()
    ).rejects.toMatchObject({ code: 'invalid_request' });
    expect(requests).toBe(0);
  });

  it('retains yielded pages when the next provider read fails', async () => {
    const loaded: unknown[] = [];
    let count = 0;
    const client = api(async () =>
      ++count === 1
        ? json({ values: [{ name: 'trunk' }], next: `${url}&page=2` })
        : json({ error: token }, 503)
    );
    await expect(
      (async () => {
        for await (const page of client.pages(branches)) loaded.push(page.data);
      })()
    ).rejects.toMatchObject({ code: 'provider_unavailable' });
    expect(loaded).toEqual([{ values: [{ name: 'trunk' }], next: `${url}&page=2` }]);
  });
});
