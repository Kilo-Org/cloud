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
const env = {
  GITHUB_APP_CLIENT_ID: 'synthetic-client',
  GITHUB_APP_CLIENT_SECRET: 'synthetic-secret',
};
const resources = () => new GitHubTaskResources('synthetic-user-token', env);
const fetchMock = vi.fn();
let responses: Map<string, unknown>;
beforeEach(() => {
  responses = new Map<string, unknown>([
    ['/repos/acme/repo', repository],
    ['/repos/acme/other', { ...repository, id: 202, node_id: 'R_other', name: 'other' }],
    [
      '/applications/synthetic-client/token/scoped',
      { token: 'synthetic-scoped-token', installation: { repository_selection: 'selected' } },
    ],
  ]);
  fetchMock.mockReset().mockImplementation(async (input: string) => {
    const value = responses.get(new URL(input).pathname);
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
      await resources().verify(grant, [{ kind: 'repository-read', owner: 'acme', name: 'other' }])
    ).toEqual({ owner: 'acme', repositoryIds: [101, 202] });
  });
  it('limits repository discovery credentials to the selected owner', async () => {
    expect(await resources().verify(grant, [{ kind: 'owner-read' }])).toEqual({ owner: 'acme' });
    await resources().scopeUserToken({ owner: 'acme' });
    expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body)).toEqual({
      access_token: 'synthetic-user-token',
      target: 'acme',
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
      ).rejects.toMatchObject({ reason: 'repository_mismatch' });
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
    });
  });
  it.each([
    { token: 'broad', installation: { repository_selection: 'all' } },
    {},
    new Response(null, { status: 403 }),
  ])('fails closed when credential narrowing fails', async value => {
    responses.set('/applications/synthetic-client/token/scoped', value);
    await expect(
      resources().scopeUserToken({ owner: 'acme', repositoryIds: [101] })
    ).rejects.toMatchObject({ reason: 'source_unavailable' });
  });
});
