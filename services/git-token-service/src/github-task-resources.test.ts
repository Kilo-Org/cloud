import {
  githubRepositoryPermissions,
  type WorkspaceGitHubRepositoryAccess,
} from '@kilocode/worker-utils/workspace-repository-access';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubTaskGrant } from '@kilocode/worker-utils/github-task-grant';
import { GitHubTaskResources } from './github-task-resources.js';

const repository = { id: 101, node_id: 'R_fixture', name: 'repo', owner: { login: 'acme' } };
const grant: GitHubTaskGrant = {
  revision: 1,
  scopeId: 'scope',
  taskRef: 'refs/heads/main',
  repository: { id: 101, nodeId: 'R_fixture', name: 'repo', owner: 'acme' },
};
const approved = (id: number, name: string): WorkspaceGitHubRepositoryAccess => ({
  repositoryId: id,
  nodeId: id === 101 ? 'R_fixture' : 'R_other',
  owner: 'acme',
  name,
  mode: 'read',
  source: 'user',
  approvedBy: 'user',
  approvedAt: 1,
  integrationId: '00000000-0000-4000-8000-000000000001',
  identity: { source: 'user', providerSubjectId: '1', appType: 'standard' },
});
const env = {
  GITHUB_APP_CLIENT_ID: 'synthetic-client',
  GITHUB_APP_CLIENT_SECRET: 'synthetic-secret',
};
const resources = () => new GitHubTaskResources('synthetic-user-token', env);
const fetchMock = vi.fn();
let responses: Map<string, unknown>;
let ids: number[];
beforeEach(() => {
  ids = [];
  responses = new Map<string, unknown>([
    ['/repos/acme/repo', repository],
    [
      '/user/installations/123/repositories',
      { total_count: 2, repositories: [{ id: 101 }, { id: 202 }] },
    ],
    ['/repos/acme/other', { ...repository, id: 202, node_id: 'R_other', name: 'other' }],
    [
      '/applications/synthetic-client/token/scoped',
      {
        token: 'synthetic-scoped-token',
        installation: {
          id: 123,
          repository_selection: 'selected',
          permissions: githubRepositoryPermissions('contribute'),
        },
      },
    ],
  ]);
  fetchMock.mockReset().mockImplementation(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname;
    let value = responses.get(path);
    if (path.endsWith('/token/scoped')) {
      const body = JSON.parse(typeof init?.body === 'string' ? init.body : '');
      ids = body.repository_ids;
      if (
        value &&
        typeof value === 'object' &&
        'token' in value &&
        value.token === 'synthetic-scoped-token'
      )
        value = {
          ...value,
          token: value.token,
          installation: {
            id: 123,
            repository_selection: 'selected',
            permissions: body.permissions,
          },
        };
    }
    if (path === '/user/installations/123/repositories')
      value = { total_count: ids.length, repositories: ids.map(id => ({ id })) };
    return value instanceof Response
      ? value
      : value === undefined
        ? new Response(null, { status: 404 })
        : Response.json(value);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('trusted GitHub repository authority', () => {
  it('resolves stable IDs without inspecting branch protection', async () => {
    expect(
      await resources().issue('acme', 'repo', { scopeId: 'scope', taskRef: 'refs/heads/main' })
    ).toEqual(grant);
    expect(await resources().verify(grant, [])).toEqual({ owner: 'acme', repositoryIds: [101] });
    expect(
      fetchMock.mock.calls.every(([url]) => new URL(url).pathname === '/repos/acme/repo')
    ).toBe(true);
  });
  it.each([{ id: 202 }, { node_id: 'R_replacement' }, { owner: { login: 'personal-user' } }])(
    'rejects selected repository drift',
    async change => {
      responses.set('/repos/acme/repo', { ...repository, ...change });
      await expect(resources().verify(grant, [])).rejects.toMatchObject({
        reason: 'repository_mismatch',
      });
    }
  );
  it('adds only the requested same-owner repository to the credential scope', async () => {
    expect(
      await resources().verify(
        grant,
        [{ kind: 'repository-read', owner: 'acme', name: 'other' }],
        [approved(202, 'other')]
      )
    ).toEqual({ owner: 'acme', repositoryIds: [101, 202] });
  });
  it('keeps repository discovery credentials limited to the task repository', async () => {
    expect(await resources().verify(grant, [{ kind: 'owner-read' }])).toEqual({
      owner: 'acme',
      repositoryIds: [101],
    });
    await resources().scopeUserToken({ owner: 'acme', repositoryIds: [101] });
    expect(
      JSON.parse(
        fetchMock.mock.calls.find(([url]) => new URL(url).pathname.endsWith('/token/scoped'))?.[1]
          .body
      )
    ).toEqual({
      access_token: 'synthetic-user-token',
      target: 'acme',
      repository_ids: [101],
      permissions: githubRepositoryPermissions('contribute'),
    });
  });
  it('probes foreign public repositories without personal authorization', async () => {
    responses.set('/repos/public-owner/public', {
      ...repository,
      id: 303,
      name: 'public',
      private: false,
      owner: { login: 'public-owner' },
    });
    expect(
      await resources().verify(grant, [
        { kind: 'repository-read', owner: 'public-owner', name: 'public' },
      ])
    ).toEqual({ owner: 'acme', repositoryIds: [101] });
    const init = fetchMock.mock.calls.at(-1)?.[1];
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(init.redirect).toBe('manual');
  });
  it.each([undefined, true])(
    'denies foreign private or unverifiable repositories even when the identity could read them',
    async privacy => {
      responses.set('/repos/personal-user/private', {
        ...repository,
        name: 'private',
        owner: { login: 'personal-user' },
        ...(privacy === undefined ? {} : { private: privacy }),
      });
      await expect(
        resources().verify(grant, [
          { kind: 'repository-read', owner: 'personal-user', name: 'private' },
        ])
      ).rejects.toMatchObject({ reason: 'repository_access_required' });
      expect(new Headers(fetchMock.mock.calls.at(-1)?.[1].headers).has('authorization')).toBe(
        false
      );
    }
  );
  it.each(['PullRequest', 'Issue'])(
    'authorizes comments on a current-repository %s by node ID',
    async type => {
      responses.set('/graphql', {
        data: { node: { __typename: type, repository: { databaseId: 101 } } },
      });
      await expect(
        resources().verify(grant, [{ kind: 'repository-subject-node', nodeId: 'node' }])
      ).resolves.toMatchObject({ owner: 'acme' });
    }
  );
  it.each([
    { __typename: 'PullRequest', repository: { databaseId: 202 } },
    { __typename: 'Issue', repository: { databaseId: 303 } },
    { __typename: 'User' },
    null,
  ])('denies opaque write targets outside the current repository', async node => {
    responses.set('/graphql', { data: { node } });
    await expect(
      resources().verify(grant, [{ kind: 'repository-subject-node', nodeId: 'node' }])
    ).rejects.toMatchObject({ reason: 'operation_not_allowed' });
  });
  it('does not treat PR IDs as issue IDs', async () => {
    responses.set('/graphql', {
      data: { node: { __typename: 'PullRequest', repository: { databaseId: 101 } } },
    });
    await expect(
      resources().verify(grant, [{ kind: 'repository-issue-node', nodeId: 'PR' }])
    ).rejects.toMatchObject({ reason: 'operation_not_allowed' });
  });
  it('never follows repository redirects', async () => {
    responses.set(
      '/repos/acme/repo',
      new Response(null, {
        status: 301,
        headers: { Location: 'https://api.github.com/repos/personal-user/private' },
      })
    );
    await expect(resources().verify(grant, [])).rejects.toMatchObject({
      reason: 'source_unavailable',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('scopes user credentials by stable repository IDs', async () => {
    expect(await resources().scopeUserToken({ owner: 'acme', repositoryIds: [101, 202] })).toBe(
      'synthetic-scoped-token'
    );
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      access_token: 'synthetic-user-token',
      target: 'acme',
      repository_ids: [101, 202],
      permissions: githubRepositoryPermissions('contribute'),
    });
  });
  it('caches only validated credentials by identity, exact repository set, permissions and expiry', async () => {
    const values = new Map<string, unknown>();
    const cache = {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        values.set(key, JSON.parse(value));
      }),
    };
    responses.set('/applications/synthetic-client/token/scoped', {
      token: 'synthetic-scoped-token',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
      installation: {
        id: 123,
        repository_selection: 'selected',
        permissions: githubRepositoryPermissions('read'),
      },
    });
    const cached = new GitHubTaskResources('synthetic-user-token', {
      ...env,
      TOKEN_CACHE: cache as unknown as KVNamespace,
    });
    await cached.scopeUserToken({ owner: 'acme', repositoryIds: [101] }, 'read');
    const first = fetchMock.mock.calls.length;
    await cached.scopeUserToken({ owner: 'acme', repositoryIds: [101] }, 'read');
    expect(fetchMock.mock.calls.length).toBe(first);
    await cached.scopeUserToken({ owner: 'acme', repositoryIds: [202] }, 'read');
    await cached.scopeUserToken({ owner: 'acme', repositoryIds: [101] }, 'contribute');
    await new GitHubTaskResources('different-user-token', {
      ...env,
      TOKEN_CACHE: cache as unknown as KVNamespace,
    }).scopeUserToken({ owner: 'acme', repositoryIds: [101] }, 'read');
    expect(
      fetchMock.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/token/scoped'))
    ).toHaveLength(4);
    for (const value of values.values())
      if (value && typeof value === 'object' && 'expiresAt' in value)
        value.expiresAt = Date.now() - 1;
    await cached.scopeUserToken({ owner: 'acme', repositoryIds: [101] }, 'read');
    expect(
      fetchMock.mock.calls.filter(([url]) => new URL(url).pathname.endsWith('/token/scoped'))
    ).toHaveLength(5);
  });

  it.each([
    { token: 'broad', installation: { repository_selection: 'all' } },
    {},
    new Response(null, { status: 403 }),
  ])('fails closed when credential narrowing fails', async value => {
    responses.set('/applications/synthetic-client/token/scoped', value);
    await expect(
      resources().scopeUserToken({ owner: 'acme', repositoryIds: [101] })
    ).rejects.toMatchObject({
      reason: value instanceof Response ? 'source_unavailable' : 'authorization_unavailable',
    });
  });
});
