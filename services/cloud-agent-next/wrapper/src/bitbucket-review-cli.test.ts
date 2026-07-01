import { describe, expect, it, spyOn } from 'bun:test';
import { runBitbucketReviewCli } from './bitbucket-review-cli';

const API_ROOT = 'https://api.bitbucket.org/2.0';
const principalUuid = '{55555555-5555-4555-8555-555555555555}';
const repositoryUuid = '{11111111-1111-4111-8111-111111111111}';
const workspaceUuid = '{33333333-3333-4333-8333-333333333333}';
const firstHeadSha = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const changedHeadSha = 'cccccccccccccccccccccccccccccccccccccccc';
const pullRequestsUrl = `${API_ROOT}/repositories/acme-workspace/widgets/pullrequests`;
const pullRequestUrl = `${pullRequestsUrl}/42`;
const commentsUrl = `${pullRequestUrl}/comments`;

const textEncoder = new TextEncoder();

type RecordedRequest = {
  url: string;
  init: RequestInit;
};

function unbracedUuid(value: string): string {
  return value.replace(/^\{|\}$/g, '');
}

function trustedEnv(): Record<string, string> {
  return {
    BITBUCKET_TOKEN: 'secret-access-token',
    KILO_BITBUCKET_WORKSPACE_SLUG: 'acme-workspace',
    KILO_BITBUCKET_WORKSPACE_UUID: workspaceUuid,
    KILO_BITBUCKET_REPOSITORY_SLUG: 'widgets',
    KILO_BITBUCKET_REPOSITORY_UUID: repositoryUuid,
  };
}

function inputStream(value: unknown): ReadableStream<Uint8Array> {
  const body = new Response(JSON.stringify(value)).body;
  if (body === null) throw new Error('expected response body');
  return body;
}

function pullRequestResponse(
  overrides: {
    headSha?: string;
    state?: 'OPEN' | 'MERGED' | 'DECLINED' | 'SUPERSEDED';
    draft?: boolean;
    sourceRepositoryUuid?: string;
    destinationRepositoryUuid?: string;
    title?: string;
    sourceBranch?: string;
    destinationBranch?: string;
    id?: number;
    htmlUrl?: string;
  } = {}
): Record<string, unknown> {
  const id = overrides.id ?? 42;
  return {
    id,
    title: overrides.title ?? 'Add safer widgets',
    state: overrides.state ?? 'OPEN',
    draft: overrides.draft ?? false,
    author: {
      uuid: principalUuid,
      display_name: 'Ada Reviewer',
    },
    source: {
      repository: {
        uuid: overrides.sourceRepositoryUuid ?? repositoryUuid,
        full_name: 'acme-workspace/widgets',
        workspace: { uuid: workspaceUuid, slug: 'acme-workspace' },
      },
      branch: { name: overrides.sourceBranch ?? 'feature/widgets' },
      commit: { hash: overrides.headSha ?? firstHeadSha },
    },
    destination: {
      repository: {
        uuid: overrides.destinationRepositoryUuid ?? repositoryUuid,
        full_name: 'acme-workspace/widgets',
        workspace: { uuid: workspaceUuid, slug: 'acme-workspace' },
      },
      branch: { name: overrides.destinationBranch ?? 'main' },
      commit: { hash: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    },
    links: {
      html: {
        href:
          overrides.htmlUrl ?? `https://bitbucket.org/acme-workspace/widgets/pull-requests/${id}`,
      },
    },
  };
}

function unbracedPullRequestResponse(): Record<string, unknown> {
  const response = pullRequestResponse();
  const source = response.source as {
    repository: { uuid: string; workspace: { uuid: string } };
  };
  const destination = response.destination as {
    repository: { uuid: string; workspace: { uuid: string } };
  };
  const author = response.author as { uuid: string };
  author.uuid = unbracedUuid(author.uuid);
  source.repository.uuid = unbracedUuid(source.repository.uuid);
  source.repository.workspace.uuid = unbracedUuid(source.repository.workspace.uuid);
  destination.repository.uuid = unbracedUuid(destination.repository.uuid);
  destination.repository.workspace.uuid = unbracedUuid(destination.repository.workspace.uuid);
  return response;
}

function pullRequestResponseWithoutRepositoryWorkspace(): Record<string, unknown> {
  const response = pullRequestResponse();
  const source = response.source as {
    repository: { workspace?: unknown };
  };
  const destination = response.destination as {
    repository: { workspace?: unknown };
  };
  delete source.repository.workspace;
  delete destination.repository.workspace;
  return response;
}

function commentResponse(
  id: number,
  body: string,
  options: {
    inline?: { path: string; from?: number | null; to?: number | null; outdated?: boolean };
    deleted?: boolean;
    parentId?: number;
  } = {}
): Record<string, unknown> {
  return {
    id,
    content: { raw: body },
    user: { uuid: principalUuid, display_name: 'Kilo Reviewer' },
    created_on: '2026-06-24T00:00:00.000Z',
    updated_on: '2026-06-24T00:00:00.000Z',
    deleted: options.deleted ?? false,
    ...(options.inline ? { inline: options.inline } : {}),
    ...(options.parentId ? { parent: { id: options.parentId } } : {}),
  };
}

function requestBody(request: RecordedRequest | undefined): Record<string, unknown> {
  if (typeof request?.init.body !== 'string') throw new Error('expected serialized request body');
  return JSON.parse(request.init.body) as Record<string, unknown>;
}

async function execute(
  args: string[],
  fetch: (url: string, init: RequestInit) => Promise<Response>,
  input?: unknown,
  env: Record<string, string | undefined> = trustedEnv(),
  options: { currentBranch?: () => Promise<string> } = {}
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await runBitbucketReviewCli({
    args,
    env,
    fetch,
    ...options,
    ...(input === undefined ? {} : { stdin: inputStream(input) }),
    stdout: value => stdout.push(value),
    stderr: value => stderr.push(value),
  });
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}

function providerFetch(options: {
  requests: RecordedRequest[];
  pullRequests?: Record<string, unknown>[];
  comments?: Record<string, unknown>[];
  diff?: string;
  createResponse?: Record<string, unknown>;
  updateResponse?: Record<string, unknown>;
}): (url: string, init: RequestInit) => Promise<Response> {
  let pullRequestIndex = 0;
  return async (url, init) => {
    options.requests.push({ url, init });
    const method = init.method ?? 'GET';
    if (url === pullRequestUrl && method === 'GET') {
      const pullRequests = options.pullRequests ?? [pullRequestResponse()];
      const response = pullRequests[Math.min(pullRequestIndex, pullRequests.length - 1)];
      pullRequestIndex += 1;
      return Response.json(response);
    }
    if (url === `${pullRequestUrl}/diff` && method === 'GET') {
      return new Response(options.diff ?? 'diff --git a/widget.ts b/widget.ts\n', {
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
    }
    if (url === `${commentsUrl}?pagelen=100` && method === 'GET') {
      return Response.json({ values: options.comments ?? [] });
    }
    if (url === commentsUrl && method === 'POST' && options.createResponse) {
      return Response.json(options.createResponse, { status: 201 });
    }
    if (url === `${commentsUrl}/30` && method === 'PUT' && options.updateResponse) {
      return Response.json(options.updateResponse);
    }
    throw new Error(`unexpected request: ${method} ${url}`);
  };
}

describe('bb', () => {
  it.each([['help'], ['--help'], ['-h'], []])(
    'prints help for %p without environment or provider access',
    async (...args) => {
      let fetchCalls = 0;
      const result = await execute(
        args.flat(),
        async () => {
          fetchCalls += 1;
          return Response.json({});
        },
        undefined,
        {}
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe('');
      expect(result.stdout).toContain('Usage: bb <command>');
      expect(result.stdout).toContain('BB_DEBUG=1');
      expect(result.stdout).toContain('Syntax:');
      expect(result.stdout).toContain(
        'bb pr create --title <title> [--description <body>] [--destination <branch>]'
      );
      expect(result.stdout).toContain('Examples:');
      expect(result.stdout).toContain('bb pr current');
      expect(result.stdout).toContain(
        `bb pr create --title "Add safer widgets" --description "Ready for review"`
      );
      expect(result.stdout).toContain('bb pr view 42');
      expect(result.stdout).toContain('bb pr diff 42');
      expect(result.stdout).toContain('bb comments list 42');
      expect(result.stdout).toContain(
        `echo '{"body": "This is a test comment added via the bb CLI tool"}' | bb comments create 1 --input -`
      );
      expect(result.stdout).toContain('bb comments create-batch <pull-request-id> --input -');
      expect(result.stdout).toContain(
        `echo '{"body": "Inline finding", "inline": {"path": "src/widget.ts", "to": 42}}' | bb comments create 1 --input -`
      );
      expect(result.stdout).toContain(
        `echo '{"body": "Updated summary"}' | bb comments update 1 123 --input -`
      );
      expect(result.stdout).toContain(
        'Create input must be {"body": "..."} or {"body": "...", "inline": {"path": "...", "to": 123}}.'
      );
      expect(result.stdout).toContain('Update input must be {"body": "..."} only.');
      expect(result.stdout).toContain('Environment:');
      expect(result.stdout).toContain('BITBUCKET_TOKEN');
      expect(result.stdout).toContain('KILO_BITBUCKET_REPOSITORY_UUID');
      expect(fetchCalls).toBe(0);
    }
  );

  it('reads an explicit pull request without a global preflight', async () => {
    const requests: RecordedRequest[] = [];
    const result = await execute(['pr', 'view', '42'], providerFetch({ requests }));

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(requests.map(request => request.url)).toEqual([pullRequestUrl]);
    expect(new Headers(requests[0]?.init.headers).get('Authorization')).toBe(
      'Bearer secret-access-token'
    );
    expect(JSON.parse(result.stdout)).toEqual(pullRequestResponse());
  });

  it('accepts unbraced UUIDs in Bitbucket pull request responses', async () => {
    const requests: RecordedRequest[] = [];
    const result = await execute(
      ['pr', 'view', '42'],
      providerFetch({
        requests,
        pullRequests: [unbracedPullRequestResponse()],
      })
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const response = JSON.parse(result.stdout) as ReturnType<typeof unbracedPullRequestResponse>;
    expect(JSON.parse(result.stdout)).toEqual(
      expect.objectContaining({
        author: expect.objectContaining({ uuid: unbracedUuid(principalUuid) }),
        source: expect.objectContaining({
          repository: expect.objectContaining({
            uuid: unbracedUuid(repositoryUuid),
            workspace: expect.objectContaining({ uuid: unbracedUuid(workspaceUuid) }),
          }),
        }),
        destination: expect.objectContaining({
          repository: expect.objectContaining({
            uuid: unbracedUuid(repositoryUuid),
            workspace: expect.objectContaining({ uuid: unbracedUuid(workspaceUuid) }),
          }),
        }),
      })
    );
    expect(response).toEqual(unbracedPullRequestResponse());
  });

  it('accepts pull request repository identity without a nested workspace object', async () => {
    const requests: RecordedRequest[] = [];
    const result = await execute(
      ['pr', 'view', '42'],
      providerFetch({
        requests,
        pullRequests: [pullRequestResponseWithoutRepositoryWorkspace()],
      })
    );

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    const response = JSON.parse(result.stdout) as {
      source: { repository: { workspace?: unknown } };
      destination: { repository: { workspace?: unknown } };
    };
    expect(response.source.repository).not.toHaveProperty('workspace');
    expect(response.destination.repository).not.toHaveProperty('workspace');
  });

  it('finds the open pull request for the current branch', async () => {
    const requests: RecordedRequest[] = [];
    const result = await execute(
      ['pr', 'current'],
      async (url, init) => {
        requests.push({ url, init });
        const parsed = new URL(url);
        expect(`${parsed.origin}${parsed.pathname}`).toBe(pullRequestsUrl);
        expect(parsed.searchParams.get('q')).toBe(
          'source.branch.name = "feature/widgets" AND state = "OPEN"'
        );
        expect(parsed.searchParams.get('pagelen')).toBe('50');
        return Response.json({ values: [pullRequestResponse()] });
      },
      undefined,
      trustedEnv(),
      { currentBranch: async () => 'feature/widgets' }
    );

    expect(result.exitCode).toBe(0);
    expect(requests.map(request => `${request.init.method} ${request.url}`).length).toBe(1);
    expect(JSON.parse(result.stdout)).toEqual({
      pullRequest: expect.objectContaining({
        id: 42,
        source: expect.objectContaining({ branch: { name: 'feature/widgets' } }),
      }),
    });
  });

  it('returns the current branch pull request instead of creating a duplicate', async () => {
    const requests: RecordedRequest[] = [];
    const result = await execute(
      ['pr', 'create', '--title', 'Add safer widgets'],
      async (url, init) => {
        requests.push({ url, init });
        if ((init.method ?? 'GET') !== 'GET') {
          throw new Error(`unexpected write: ${init.method} ${url}`);
        }
        return Response.json({ values: [pullRequestResponse()] });
      },
      undefined,
      trustedEnv(),
      { currentBranch: async () => 'feature/widgets' }
    );

    expect(result.exitCode).toBe(0);
    expect(requests).toHaveLength(1);
    expect(JSON.parse(result.stdout)).toEqual({
      created: false,
      pullRequest: expect.objectContaining({ id: 42 }),
    });
  });

  it('creates a pull request from the current branch when none exists', async () => {
    const requests: RecordedRequest[] = [];
    const result = await execute(
      ['pr', 'create', '--title', 'Open safer widgets', '--description', 'Ready for review'],
      async (url, init) => {
        requests.push({ url, init });
        const method = init.method ?? 'GET';
        if (url.startsWith(`${pullRequestsUrl}?`) && method === 'GET') {
          return Response.json({ values: [] });
        }
        if (url === pullRequestsUrl && method === 'POST') {
          expect(requestBody(requests.at(-1))).toEqual({
            title: 'Open safer widgets',
            description: 'Ready for review',
            source: { branch: { name: 'feature/widgets' } },
          });
          return Response.json(
            pullRequestResponse({
              id: 43,
              title: 'Open safer widgets',
              sourceBranch: 'feature/widgets',
              destinationBranch: 'main',
            }),
            { status: 201 }
          );
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      },
      undefined,
      trustedEnv(),
      { currentBranch: async () => 'feature/widgets' }
    );

    expect(result.exitCode).toBe(0);
    expect(requests.map(request => `${request.init.method} ${request.url}`)).toEqual([
      expect.stringContaining(`GET ${pullRequestsUrl}?`),
      `POST ${pullRequestsUrl}`,
    ]);
    expect(JSON.parse(result.stdout)).toEqual({
      created: true,
      pullRequest: expect.objectContaining({ id: 43, title: 'Open safer widgets' }),
    });
  });

  it.each([
    ['missing PR', ['pr', 'view'], 'expected PR view syntax: bb pr view <pull-request-id>'],
    ['zero PR', ['pr', 'view', '0'], 'expected PR view syntax: bb pr view <pull-request-id>'],
    ['negative PR', ['pr', 'diff', '-1'], 'expected PR diff syntax: bb pr diff <pull-request-id>'],
    [
      'unsafe PR',
      ['comments', 'list', '9007199254740992'],
      'expected comments list syntax: bb comments list <pull-request-id>',
    ],
    [
      'extra argv',
      ['pr', 'view', '42', 'extra'],
      'expected PR view syntax: bb pr view <pull-request-id>',
    ],
    [
      'missing create input flag',
      ['comments', 'create', '42'],
      'expected comments create syntax: bb comments create <pull-request-id> --input -',
    ],
    [
      'invalid comment ID',
      ['comments', 'update', '42', '0', '--input', '-'],
      'expected comments update syntax: bb comments update <pull-request-id> <comment-id> --input -',
    ],
    [
      'missing PR create title',
      ['pr', 'create'],
      'expected PR create syntax: bb pr create --title <title> [--description <body>] [--destination <branch>]',
    ],
    [
      'extra PR current argv',
      ['pr', 'current', 'extra'],
      'expected PR current syntax: bb pr current',
    ],
    [
      'unknown command',
      ['workspace', 'view'],
      'expected command: bb help | bb pr current | bb pr create --title <title>',
    ],
  ])('rejects %s before environment or provider access', async (_name, args, expectedHint) => {
    let fetchCalls = 0;
    const result = await execute(
      args,
      async () => {
        fetchCalls += 1;
        return Response.json({});
      },
      undefined,
      {}
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bb: invalid_command\n');
    expect(result.stderr).toContain(`bb: ${expectedHint}`);
    expect(fetchCalls).toBe(0);
  });

  it('explains the expected environment for commands that need provider access', async () => {
    let fetchCalls = 0;
    const result = await execute(
      ['pr', 'view', '42'],
      async () => {
        fetchCalls += 1;
        return Response.json({});
      },
      undefined,
      {}
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bb: invalid_environment\n');
    expect(result.stderr).toContain(
      'bb: expected Bitbucket cloud-agent environment: BITBUCKET_TOKEN, KILO_BITBUCKET_WORKSPACE_SLUG, KILO_BITBUCKET_WORKSPACE_UUID, KILO_BITBUCKET_REPOSITORY_SLUG, KILO_BITBUCKET_REPOSITORY_UUID'
    );
    expect(fetchCalls).toBe(0);
  });

  it('prints sanitized debug metadata without exposing tokens or raw provider bodies', async () => {
    const result = await execute(
      ['comments', 'create', '42', '--input', '-'],
      providerFetch({
        requests: [],
        pullRequests: [
          {
            ...pullRequestResponse({ destinationRepositoryUuid: 'not-a-uuid' }),
            secretBodyText: 'provider body should not be echoed',
          },
        ],
      }),
      { body: 'Summary' },
      { ...trustedEnv(), BB_DEBUG: '1' }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('bb debug: ');
    expect(result.stderr).toContain('"event":"provider_response"');
    expect(result.stderr).toContain('"event":"command_error"');
    expect(result.stderr).toContain('"code":"invalid_provider_response"');
    expect(result.stderr).not.toContain('secret-access-token');
    expect(result.stderr).not.toContain('provider body should not be echoed');
  });

  it('reads a diff directly for the explicit pull request', async () => {
    const requests: RecordedRequest[] = [];
    const result = await execute(['pr', 'diff', '42'], providerFetch({ requests }));

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('diff --git');
    expect(requests.map(request => request.url)).toEqual([`${pullRequestUrl}/diff`]);
  });

  it('lists changed file paths from pull request diffstat', async () => {
    const requests: RecordedRequest[] = [];
    const redirect = `${API_ROOT}/repositories/acme-workspace/widgets/diffstat/main..feature/widgets?from_pullrequest_id=42`;
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      requests.push({ url, init });
      if (url === `${pullRequestUrl}/diffstat`) {
        return new Response(null, { status: 302, headers: { Location: redirect } });
      }
      if (url === redirect) {
        return Response.json({
          values: [
            { new: { path: 'src/widget.ts' }, old: { path: 'src/widget.ts' } },
            { new: null, old: { path: 'src/deleted.ts' } },
          ],
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await execute(['pr', 'diff', '42', '--name-only'], fetch);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('src/widget.ts\nsrc/deleted.ts\n');
    expect(requests.map(request => request.url)).toEqual([`${pullRequestUrl}/diffstat`, redirect]);
  });

  it('follows only a validated Bitbucket diff redirect for the same pull request', async () => {
    const requests: RecordedRequest[] = [];
    const redirect = `${API_ROOT}/repositories/acme-workspace/widgets/diff/main..feature/widgets?from_pullrequest_id=42&topic=true`;
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      requests.push({ url, init });
      if (url === `${pullRequestUrl}/diff`) {
        return new Response(null, { status: 302, headers: { Location: redirect } });
      }
      if (url === redirect) {
        return new Response('diff --git a/widget.ts b/widget.ts\n', {
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await execute(['pr', 'diff', '42'], fetch);

    expect(result.exitCode).toBe(0);
    expect(requests.map(request => request.url)).toEqual([`${pullRequestUrl}/diff`, redirect]);
  });

  it('allows provider-added query parameters on same-PR diff redirects', async () => {
    const requests: RecordedRequest[] = [];
    const redirect = `${API_ROOT}/repositories/acme-workspace/widgets/diff/main..feature/widgets?from_pullrequest_id=42&topic=true&context=3`;
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      requests.push({ url, init });
      if (url === `${pullRequestUrl}/diff`) {
        return new Response(null, { status: 302, headers: { Location: redirect } });
      }
      if (url === redirect) {
        return new Response('diff --git a/widget.ts b/widget.ts\n', {
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await execute(['pr', 'diff', '42'], fetch);

    expect(result.exitCode).toBe(0);
    expect(requests.map(request => request.url)).toEqual([`${pullRequestUrl}/diff`, redirect]);
  });

  it('follows Bitbucket diff redirects that use carriage return between commit hashes', async () => {
    const requests: RecordedRequest[] = [];
    const redirect = `${API_ROOT}/repositories/acme-workspace/widgets/diff/acme-workspace/widgets:b2baee27adc2%0D50c3b1607dd8`;
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      requests.push({ url, init });
      if (url === `${pullRequestUrl}/diff`) {
        return new Response(null, { status: 302, headers: { Location: redirect } });
      }
      if (url === redirect) {
        return new Response('diff --git a/widget.ts b/widget.ts\n', {
          headers: { 'Content-Type': 'text/plain' },
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await execute(['pr', 'diff', '42'], fetch);

    expect(result.exitCode).toBe(0);
    expect(requests.map(request => request.url)).toEqual([`${pullRequestUrl}/diff`, redirect]);
  });

  it('rejects a diff redirect targeting a different pull request', async () => {
    const requests: RecordedRequest[] = [];
    const result = await execute(['pr', 'diff', '42'], async (url, init) => {
      requests.push({ url, init });
      return new Response(null, {
        status: 302,
        headers: {
          Location: `${API_ROOT}/repositories/acme-workspace/widgets/diff/main..feature?from_pullrequest_id=43&topic=true`,
        },
      });
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('bb: redirect_rejected\n');
    expect(requests).toHaveLength(1);
  });

  it('reads complete validated comment pagination for the explicit pull request', async () => {
    const requests: RecordedRequest[] = [];
    const firstPageUrl = `${commentsUrl}?pagelen=100`;
    const secondPageUrl = `${commentsUrl}?page=2&pagelen=100`;
    const fetch = async (url: string, init: RequestInit): Promise<Response> => {
      requests.push({ url, init });
      if (url === firstPageUrl) {
        return Response.json({
          values: [
            commentResponse(10, 'Current inline', {
              inline: { path: 'src/widget.ts', from: null, to: 7, outdated: false },
            }),
          ],
          next: secondPageUrl,
        });
      }
      if (url === secondPageUrl) {
        return Response.json({
          values: [
            commentResponse(11, 'Deleted reply', { deleted: true, parentId: 10 }),
            commentResponse(12, 'Old side', {
              inline: { path: 'src/widget.ts', from: 4, to: null, outdated: false },
            }),
          ],
        });
      }
      throw new Error(`unexpected URL: ${url}`);
    };

    const result = await execute(['comments', 'list', '42'], fetch);

    expect(result.exitCode).toBe(0);
    expect(requests.map(request => request.url)).toEqual([firstPageUrl, secondPageUrl]);
    expect(JSON.parse(result.stdout)).toEqual({
      comments: [
        commentResponse(10, 'Current inline', {
          inline: { path: 'src/widget.ts', from: null, to: 7, outdated: false },
        }),
        commentResponse(11, 'Deleted reply', { deleted: true, parentId: 10 }),
        commentResponse(12, 'Old side', {
          inline: { path: 'src/widget.ts', from: 4, to: null, outdated: false },
        }),
      ],
    });
  });

  it('returns raw comment payloads instead of rejecting provider shape changes', async () => {
    const comments = [
      {
        id: 21,
        content: { raw: 'No deleted flag or user object on this provider shape' },
        links: { html: { href: 'https://bitbucket.org/acme-workspace/widgets/pull-requests/42' } },
      },
    ];
    const result = await execute(['comments', 'list', '42'], async () =>
      Response.json({ values: comments })
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ comments });
  });

  it('follows comment pagination URLs with provider-added query parameters', async () => {
    const requests: RecordedRequest[] = [];
    const result = await execute(['comments', 'list', '42'], async (url, init) => {
      requests.push({ url, init });
      if (url.includes('page=2')) {
        return Response.json({ values: [commentResponse(22, 'Second page')] });
      }
      return Response.json({
        values: [commentResponse(21, 'First page')],
        next: `${commentsUrl}?page=2&pagelen=100&fields=values.content.raw`,
      });
    });

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      comments: [commentResponse(21, 'First page'), commentResponse(22, 'Second page')],
    });
    expect(requests.map(request => request.url)).toEqual([
      `${commentsUrl}?pagelen=100`,
      `${commentsUrl}?page=2&pagelen=100&fields=values.content.raw`,
    ]);
  });

  it('fails comment page overflow instead of returning an incomplete list', async () => {
    const requests: RecordedRequest[] = [];
    const result = await execute(['comments', 'list', '42'], async (url, init) => {
      requests.push({ url, init });
      const parsed = new URL(url);
      const page = Number(parsed.searchParams.get('page') ?? '1');
      return Response.json({
        values: [],
        next: `${commentsUrl}?page=${page + 1}&pagelen=100`,
      });
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('bb: pagination_limit_exceeded\n');
    expect(requests).toHaveLength(50);
  });

  it('fails comment item overflow instead of returning a truncated list', async () => {
    const requests: RecordedRequest[] = [];
    const comments = Array.from({ length: 101 }, (_, index) =>
      commentResponse(index + 1, `Comment ${index + 1}`)
    );
    const result = await execute(['comments', 'list', '42'], providerFetch({ requests, comments }));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('bb: pagination_limit_exceeded\n');
  });

  it('fails a declared oversized diff without printing provider data', async () => {
    const result = await execute(
      ['pr', 'diff', '42'],
      async () =>
        new Response('secret-access-token provider detail', {
          headers: {
            'Content-Type': 'text/plain',
            'Content-Length': String(10 * 1024 * 1024 + 1),
          },
        })
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('bb: provider_response_too_large\n');
    expect(result.stderr).not.toContain('secret-access-token');
  });

  it('creates a comment after one immediate open and non-draft PR reread', async () => {
    const requests: RecordedRequest[] = [];
    const providerResponse = { id: 21, provider: 'accepted' };
    const result = await execute(
      ['comments', 'create', '42', '--input', '-'],
      providerFetch({ requests, createResponse: providerResponse }),
      { body: '  Potential issue\r\nwith details  ', inline: { path: 'src/widget.ts', to: 7 } }
    );

    expect(result.exitCode).toBe(0);
    expect(requests.map(request => `${request.init.method} ${request.url}`)).toEqual([
      `GET ${pullRequestUrl}`,
      `POST ${commentsUrl}`,
    ]);
    expect(requestBody(requests.at(-1))).toEqual({
      content: { raw: 'Potential issue\nwith details' },
      inline: { path: 'src/widget.ts', to: 7 },
    });
    expect(JSON.parse(result.stdout)).toEqual(providerResponse);
  });

  it('creates a shared summary comment body as raw Bitbucket markdown', async () => {
    const requests: RecordedRequest[] = [];
    const body = [
      '## Code Review Summary',
      '',
      '**Status:** No Issues Found | **Recommendation:** Merge',
    ].join('\n');
    const providerResponse = commentResponse(30, body);
    const result = await execute(
      ['comments', 'create', '42', '--input', '-'],
      providerFetch({ requests, createResponse: providerResponse }),
      { body }
    );

    expect(result.exitCode).toBe(0);
    expect(requests.map(request => `${request.init.method} ${request.url}`)).toEqual([
      `GET ${pullRequestUrl}`,
      `GET ${commentsUrl}?pagelen=100`,
      `POST ${commentsUrl}`,
    ]);
    expect(requestBody(requests.at(-1))).toEqual({ content: { raw: body } });
    expect(JSON.parse(result.stdout)).toEqual(providerResponse);
  });

  it('rejects creating a duplicate top-level Code Review Summary', async () => {
    const requests: RecordedRequest[] = [];
    const body = [
      '## Code Review Summary',
      '',
      '**Status:** No Issues Found | **Recommendation:** Merge',
    ].join('\n');
    const result = await execute(
      ['comments', 'create', '42', '--input', '-'],
      providerFetch({
        requests,
        comments: [commentResponse(29, '## Code Review Summary\n\n**Status:** Previous summary')],
      }),
      { body }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bb: summary_already_exists\n');
    expect(requests.map(request => `${request.init.method} ${request.url}`)).toEqual([
      `GET ${pullRequestUrl}`,
      `GET ${commentsUrl}?pagelen=100`,
    ]);
    expect(requests.some(request => request.init.method === 'POST')).toBe(false);
  });

  it('creates a batch of comments after one immediate writable PR reread', async () => {
    const requests: RecordedRequest[] = [];
    let created = 0;
    const result = await execute(
      ['comments', 'create-batch', '42', '--input', '-'],
      async (url, init) => {
        requests.push({ url, init });
        if (url === pullRequestUrl && (init.method ?? 'GET') === 'GET') {
          return Response.json(pullRequestResponse());
        }
        if (url === commentsUrl && init.method === 'POST') {
          created += 1;
          return Response.json(commentResponse(40 + created, `Created ${created}`), {
            status: 201,
          });
        }
        throw new Error(`unexpected request: ${init.method} ${url}`);
      },
      {
        comments: [
          { body: 'First issue', inline: { path: 'src/widget.ts', to: 7 } },
          { body: 'Second issue', inline: { path: 'src/widget.ts', to: 9 } },
        ],
      }
    );

    expect(result.exitCode).toBe(0);
    expect(requests.map(request => `${request.init.method} ${request.url}`)).toEqual([
      `GET ${pullRequestUrl}`,
      `POST ${commentsUrl}`,
      `POST ${commentsUrl}`,
    ]);
    expect(requestBody(requests[1])).toEqual({
      content: { raw: 'First issue' },
      inline: { path: 'src/widget.ts', to: 7 },
    });
    expect(requestBody(requests[2])).toEqual({
      content: { raw: 'Second issue' },
      inline: { path: 'src/widget.ts', to: 9 },
    });
    expect(JSON.parse(result.stdout)).toEqual({
      comments: [commentResponse(41, 'Created 1'), commentResponse(42, 'Created 2')],
    });
  });

  it('rejects summary bodies in batch creates before contacting the provider', async () => {
    let fetchCalls = 0;
    const result = await execute(
      ['comments', 'create-batch', '42', '--input', '-'],
      async () => {
        fetchCalls += 1;
        return Response.json({});
      },
      {
        comments: [
          { body: 'Inline finding', inline: { path: 'src/widget.ts', to: 7 } },
          { body: '## Code Review Summary\n\n**Status:** No Issues Found' },
        ],
      }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bb: invalid_input\n');
    expect(fetchCalls).toBe(0);
  });

  it.each([
    ['closed', pullRequestResponse({ state: 'MERGED' })],
    ['draft', pullRequestResponse({ draft: true })],
  ])('stops a create when the immediate PR reread is %s', async (_name, current) => {
    const requests: RecordedRequest[] = [];
    const result = await execute(
      ['comments', 'create', '42', '--input', '-'],
      providerFetch({ requests, pullRequests: [current] }),
      { body: 'Potential issue' }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('bb: pull_request_not_writable\n');
    expect(requests.some(request => request.init.method === 'POST')).toBe(false);
  });

  it('does not compare the immediate write fence against a stored expected SHA', async () => {
    const requests: RecordedRequest[] = [];
    const providerResponse = commentResponse(21, 'Potential issue');
    const result = await execute(
      ['comments', 'create', '42', '--input', '-'],
      providerFetch({
        requests,
        pullRequests: [pullRequestResponse({ headSha: changedHeadSha })],
        createResponse: providerResponse,
      }),
      { body: 'Potential issue' }
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(providerResponse);
  });

  it('updates an explicit comment after one immediate PR reread', async () => {
    const requests: RecordedRequest[] = [];
    const providerResponse = commentResponse(30, 'Updated summary');
    const result = await execute(
      ['comments', 'update', '42', '30', '--input', '-'],
      providerFetch({ requests, updateResponse: providerResponse }),
      { body: ' Updated summary ' }
    );

    expect(result.exitCode).toBe(0);
    expect(requests.map(request => `${request.init.method} ${request.url}`)).toEqual([
      `GET ${pullRequestUrl}`,
      `PUT ${commentsUrl}/30`,
    ]);
    expect(requestBody(requests.at(-1))).toEqual({ content: { raw: 'Updated summary' } });
    expect(JSON.parse(result.stdout)).toEqual(providerResponse);
  });

  it('rejects invalid input before the immediate write fence', async () => {
    let fetchCalls = 0;
    const result = await execute(
      ['comments', 'create', '42', '--input', '-'],
      async () => {
        fetchCalls += 1;
        return Response.json({});
      },
      { body: 'Potential issue', inline: { path: '../secret', to: 7 } }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bb: invalid_input\n');
    expect(result.stderr).toContain(
      'bb: expected create input JSON: {"body":"..."} or {"body":"...","inline":{"path":"src/widget.ts","to":42}}'
    );
    expect(result.stderr).not.toContain('Potential issue');
    expect(fetchCalls).toBe(0);
  });

  it('explains the expected create input shape on invalid stdin JSON', async () => {
    let fetchCalls = 0;
    const result = await execute(
      ['comments', 'create', '42', '--input', '-'],
      async () => {
        fetchCalls += 1;
        return Response.json({});
      },
      { body: 'Potential issue', inline: { path: 'src/widget.ts', line: 7 } }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bb: invalid_input\n');
    expect(result.stderr).toContain(
      'bb: expected create input JSON: {"body":"..."} or {"body":"...","inline":{"path":"src/widget.ts","to":42}}'
    );
    expect(result.stderr).not.toContain('Potential issue');
    expect(fetchCalls).toBe(0);
  });

  it('explains the expected update input shape on invalid stdin JSON', async () => {
    let fetchCalls = 0;
    const result = await execute(
      ['comments', 'update', '42', '30', '--input', '-'],
      async () => {
        fetchCalls += 1;
        return Response.json({});
      },
      { body: 'Updated summary', inline: { path: 'src/widget.ts', to: 7 } }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('bb: invalid_input\n');
    expect(result.stderr).toContain('bb: expected update input JSON: {"body":"..."}');
    expect(result.stderr).not.toContain('Updated summary');
    expect(fetchCalls).toBe(0);
  });

  it('rejects oversized JSON input before provider access', async () => {
    let fetchCalls = 0;
    const oversizedBody = 'x'.repeat(128 * 1024);
    expect(textEncoder.encode(oversizedBody).byteLength).toBeGreaterThan(64 * 1024);
    const result = await execute(
      ['comments', 'create', '42', '--input', '-'],
      async () => {
        fetchCalls += 1;
        return Response.json({});
      },
      { body: oversizedBody }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('bb: input_too_large\n');
    expect(fetchCalls).toBe(0);
  });

  it('returns raw write responses instead of requiring a projected comment shape', async () => {
    const requests: RecordedRequest[] = [];
    const createResponse = { type: 'pullrequest_comment', content: { raw: 'Summary' } };
    const result = await execute(
      ['comments', 'create', '42', '--input', '-'],
      providerFetch({ requests, createResponse }),
      { body: 'Summary' }
    );

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(createResponse);
  });

  it('rejects fixed repository identity mismatches before comment writes', async () => {
    const requests: RecordedRequest[] = [];
    const result = await execute(
      ['comments', 'create', '42', '--input', '-'],
      providerFetch({
        requests,
        pullRequests: [
          pullRequestResponse({
            destinationRepositoryUuid: '{77777777-7777-4777-8777-777777777777}',
          }),
        ],
      }),
      { body: 'Summary' }
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('bb: repository_identity_mismatch\n');
  });

  it('applies a 30-second provider timeout and maps aborts to a safe error', async () => {
    const controller = new AbortController();
    const timeout = spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      expect(milliseconds).toBe(30_000);
      return controller.signal;
    });

    try {
      const resultPromise = execute(['pr', 'view', '42'], async (_url, init) => {
        expect(init.signal).toBe(controller.signal);
        return await new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
          controller.abort(new DOMException('timed out', 'TimeoutError'));
        });
      });

      const result = await resultPromise;
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('bb: provider_unavailable\n');
      expect(timeout).toHaveBeenCalledWith(30_000);
    } finally {
      timeout.mockRestore();
    }
  });

  it('normalizes provider failures without exposing raw errors or token data', async () => {
    const result = await execute(['comments', 'list', '42'], async () =>
      Response.json(
        {
          error: {
            message: 'secret-access-token raw provider detail',
            authorization: 'Bearer secret-access-token',
          },
        },
        { status: 429 }
      )
    );

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('bb: rate_limited\n');
    expect(result.stderr).not.toContain('secret-access-token');
    expect(result.stderr).not.toContain('provider detail');
  });
});
