import { afterEach, describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import { GitHubSessionCapabilityCodec } from './github-session-capability.js';
import { GitLabSessionCapabilityCodec } from './gitlab-session-capability.js';
import { BitbucketSessionCapabilityCodec } from './bitbucket-session-capability.js';
import { openReviewCapability, scopeReviewCapability } from './review-capability.js';
import { forwardReviewRequest } from './review-forwarding.js';
import cliRequests from './fixtures/github-cli-task-requests.json';
import { reviewOperation } from './review-request-policy.js';
import type { CapabilityPurpose } from '@kilocode/worker-utils/scm-capability-contract';

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
const id = '11111111-1111-4111-8111-111111111111';
const head = 'a'.repeat(40);
const key = Buffer.alloc(32, 4).toString('base64');
const common = {
  userId: 'user-1',
  orgId: id,
  integrationId: id,
  outboundContainerId: 'allocation-1',
};
const env = {
  HYPERDRIVE: { connectionString: 'unused' },
  GITHUB_APP_BOT_USER_ID: '123',
} as unknown as CloudflareEnv;
const summary = '<!-- kilo-review -->\n## Code Review Summary\n<details>Review</details>';
const bbAuthor = { kind: 'workspace_access_token', uuid: 'actor-1' };

async function issue(provider: CapabilityPurpose, additional = false) {
  const limit = vi
    .fn()
    .mockResolvedValue([
      { number: 7, head, repository: 'o/r', platform: provider, integrationId: id },
    ]);
  vi.mocked(getWorkerDb).mockReturnValue({
    select: () => ({ from: () => ({ where: () => ({ limit }) }) }),
  } as never);
  let capability: string;
  if (provider === 'github')
    capability = new GitHubSessionCapabilityCodec(key).issue({
      ...common,
      owner: 'o',
      repo: 'r',
      source: 'installation',
      identity: {
        installationId: '1',
        accountLogin: 'o',
        appType: 'standard',
        gitAuthor: { name: 'Review', email: 'review@example.com' },
      },
    });
  else if (provider === 'gitlab')
    capability = new GitLabSessionCapabilityCodec(key).issue({
      ...common,
      instanceOrigin: 'https://gitlab.example.com',
      projectPath: 'o/r',
      authType: 'pat',
      identity: { accountId: '1', accountLogin: null },
      source: { type: 'project', projectId: 1, tokenDigest: 'a'.repeat(64) },
    });
  else
    capability = new BitbucketSessionCapabilityCodec(key).issue({
      ...common,
      workspaceSlug: 'o',
      workspaceUuid: id,
      repositoryUuid: id,
      repositoryFullName: 'o/r',
      tokenDigest: 'a'.repeat(64),
    });
  const wrapped = await scopeReviewCapability(
    env,
    { provider, capability, reviewId: id, sessionId: 'workspace-1', additional },
    key
  );
  expect(wrapped).not.toContain(capability);
  return openReviewCapability(provider, wrapped, key);
}

function request(url: string, method = 'GET', body?: unknown) {
  return new Request(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'test',
      'X-HTTP-Method-Override': 'DELETE',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
afterEach(() => vi.unstubAllGlobals());

describe.each(['github', 'gitlab', 'bitbucket'] as const)(
  '%s scoped review forwarding',
  provider => {
    it('issues a bound grant and forwards only fetch, review reads and assigned comments', async () => {
      const scope = await issue(provider);
      const reviewPath = {
        github: '/pulls/7',
        gitlab: '/merge_requests/7',
        bitbucket: '/pullrequests/7',
      }[provider];
      const target = scope.apiRoot + reviewPath;
      const upstream = vi.fn(async (url: string, init: RequestInit) => {
        expect(new Headers(init.headers).has('X-HTTP-Method-Override')).toBe(false);
        if (url.endsWith('/user')) return Response.json({ id: 123 });
        if (url.endsWith('/comments/42'))
          return Response.json({
            user: provider === 'github' ? { id: 123 } : bbAuthor,
            issue_url: scope.apiRoot + '/issues/7',
            body: summary,
            content: { raw: '## Code Review Summary' },
          });
        if (url.endsWith('/notes/42'))
          return Response.json({ author: { id: 123 }, system: false, body: summary });
        if (provider === 'bitbucket' && init.method === 'POST')
          return Response.json({ user: bbAuthor }, { status: 201 });
        if (provider === 'bitbucket' && url.includes('/comments?'))
          return Response.json({ values: [] });
        return Response.json({
          id: 7,
          state: 'OPEN',
          draft: false,
          destination: { repository: { uuid: id } },
          source: { commit: { hash: head } },
        });
      });
      vi.stubGlobal('fetch', upstream);
      const access = {
        redeem: async () => new Headers({ Authorization: 'Bearer synthetic' }),
        bitbucketAuthor: { current: async () => bbAuthor.uuid, record: vi.fn(async () => {}) },
      };
      const send = (req: Request) => forwardReviewRequest(scope, req, access);
      for (const req of [
        request(scope.gitUrl + '/info/refs?service=git-upload-pack'),
        request(target),
      ])
        expect((await send(req)).ok).toBe(true);
      const inline = {
        github: request(target + '/reviews', 'POST', {
          commit_id: head,
          event: 'COMMENT',
          comments: [{ path: 'file', line: 1, side: 'RIGHT', body: 'Finding' }],
        }),
        gitlab: request(target + '/discussions', 'POST', {
          body: 'Finding',
          position: {
            base_sha: head,
            start_sha: head,
            head_sha: head,
            position_type: 'text',
            new_path: 'file',
            new_line: 1,
          },
        }),
        bitbucket: request(target + '/comments', 'POST', {
          content: { raw: 'Finding' },
          inline: { path: 'file', to: 1 },
        }),
      }[provider];
      const create = {
        github: request(scope.apiRoot + '/issues/7/comments', 'POST', { body: summary }),
        gitlab: request(target + '/notes', 'POST', { body: summary }),
        bitbucket: request(target + '/comments', 'POST', {
          content: { raw: '## Code Review Summary' },
        }),
      }[provider];
      const edit = {
        github: request(scope.apiRoot + '/issues/comments/42', 'PATCH', { body: summary }),
        gitlab: request(target + '/notes/42', 'PUT', { body: summary }),
        bitbucket: request(target + '/comments/42', 'PUT', {
          content: { raw: '## Code Review Summary' },
        }),
      }[provider];
      for (const req of [inline, create, edit]) expect((await send(req)).ok).toBe(true);
      expect(
        upstream.mock.calls.filter(
          ([, init]) => init.method && !['GET', 'HEAD'].includes(init.method)
        )
      ).toHaveLength(3);
      upstream.mockClear();
      for (const req of [
        request(scope.gitUrl + '/info/refs?service=git-receive-pack'),
        request(scope.gitUrl + '/git-receive-pack', 'POST'),
        request(target + '/merge', 'PUT', {}),
        request(target + '/approve', 'POST', {}),
        request(scope.apiRoot + reviewPath.slice(0, -2), 'POST', {}),
        request(create.url.replace('/7/', '/8/'), 'POST', { body: summary }),
        request(scope.apiRoot + '/refs/heads', 'POST', {}),
        request(target + '/reviews', 'POST', { event: 'APPROVE', commit_id: head, comments: [] }),
        request(target + '/notes', 'POST', { body: summary + '\n/close' }),
      ])
        expect((await send(req)).status).toBe(403);
      expect(upstream).not.toHaveBeenCalled();
      const other = await issue(provider, true);
      expect(
        reviewOperation(
          other,
          'GET',
          new URL(other.gitUrl + '/info/refs?service=git-upload-pack'),
          undefined
        )
      ).toBe('git');
      expect(reviewOperation(other, 'GET', new URL(target), undefined)).toBeNull();
    });
    it('rejects edits to another author before forwarding the write', async () => {
      const scope = await issue(provider);
      const upstream = vi.fn(async (url: string) =>
        Response.json(
          url.endsWith('/user')
            ? { id: 123 }
            : url.endsWith('/pullrequests/7')
              ? {
                  id: 7,
                  state: 'OPEN',
                  draft: false,
                  destination: { repository: { uuid: id } },
                  source: { commit: { hash: head } },
                }
              : {
                  user: { kind: 'workspace_access_token', uuid: 'other', id: 456 },
                  issue_url: scope.apiRoot + '/issues/7',
                  author: { id: 456 },
                  system: false,
                  body: summary,
                  content: { raw: '## Code Review Summary' },
                }
        )
      );
      vi.stubGlobal('fetch', upstream);
      const [path, method] = {
        github: ['/issues/comments/9', 'PATCH'],
        gitlab: ['/merge_requests/7/notes/9', 'PUT'],
        bitbucket: ['/pullrequests/7/comments/9', 'PUT'],
      }[provider];
      const res = await forwardReviewRequest(
        scope,
        request(
          scope.apiRoot + path,
          method,
          provider === 'bitbucket'
            ? { content: { raw: '## Code Review Summary' } }
            : { body: summary }
        ),
        {
          redeem: async () => new Headers(),
          bitbucketAuthor: { current: async () => 'own', record: vi.fn(async () => {}) },
        }
      );
      expect(res.status).toBe(403);
      expect(upstream).toHaveBeenCalled();
      for (const call of vi.mocked(fetch).mock.calls) expect(call[1]?.method ?? 'GET').toBe('GET');
    });
  }
);

it('limits both default gh pr view queries to the assigned PR', async () => {
  const scope = await issue('github');
  const url = new URL('https://api.github.com/graphql');
  const queries = cliRequests.requests.filter(entry => entry.command === 'gh pr view');
  expect(queries).toHaveLength(2);
  for (const { body } of queries) {
    const variables = { owner: 'o', name: 'r', repo: 'r', number: 7, pr_number: 7 };
    expect(reviewOperation(scope, 'POST', url, { ...body, variables })).toBe('read');
    expect(
      reviewOperation(scope, 'POST', url, {
        ...body,
        variables: { ...variables, pr_number: 8, number: 8 },
      })
    ).toBeNull();
  }
});

it('rejects oversized publication before redemption', async () => {
  const scope = await issue('gitlab');
  const redeem = vi.fn();
  const result = await forwardReviewRequest(
    scope,
    request(scope.apiRoot + '/merge_requests/7/notes', 'POST', {
      body: summary + 'x'.repeat(262144),
    }),
    { redeem }
  );
  expect(result.status).toBe(403);
  expect(redeem).not.toHaveBeenCalled();
});

it('permits the read requests used by glab mr view --comments and glab mr diff', async () => {
  const scope = await issue('gitlab');
  const root = scope.apiRoot + '/merge_requests/7';
  for (const suffix of [
    '?include_diverged_commits_count=true&include_rebase_in_progress=true&render_html=true',
    '/approval_state',
    '/discussions?page=1&per_page=20&sort=asc',
    '/versions',
    '/versions/1',
  ]) {
    expect(reviewOperation(scope, 'GET', new URL(root + suffix), undefined)).toBe('read');
    expect(reviewOperation(scope, 'PUT', new URL(root + suffix), {})).toBeNull();
  }
});
