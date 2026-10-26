import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubTaskGrant } from '@kilocode/worker-utils/github-task-grant';
import { authorizeGitHubTaskRequest, type GitHubTaskRequest } from './github-task-policy.js';
import { authorizeGitHubTaskCredential } from './github-task-authorization.js';
import type { GetCloudAgentAuthForRepoSuccess } from './index.js';

const grant: GitHubTaskGrant = {
  revision: 1,
  scopeId: 'org-worktree',
  taskRef: 'refs/heads/main',
  repository: {
    id: 101,
    nodeId: 'R_current',
    owner: 'acme',
    name: 'current',
  },
};
const auth: GetCloudAgentAuthForRepoSuccess = {
  success: true,
  source: 'user',
  githubToken: 'ambient-personal-token',
  installationId: '123',
  accountLogin: 'acme',
  appType: 'standard',
  gitAuthor: { name: 'Person', email: 'person@example.test' },
};
const env = {
  GITHUB_APP_CLIENT_ID: 'synthetic-client',
  GITHUB_APP_CLIENT_SECRET: 'synthetic-secret',
};
const tokens = { getToken: vi.fn(), getTokenForRepositoryIds: vi.fn() };
const fetchMock = vi.fn();
const repo = (id: number, owner: string, name: string, privacy = true) => ({
  id,
  node_id: `R_${id}`,
  owner: { login: owner },
  name,
  private: privacy,
});
const graphql = (owner: string, name: string): GitHubTaskRequest => ({
  method: 'POST',
  url: 'https://api.github.com/graphql',
  contentType: 'application/json',
  body: new TextEncoder().encode(
    JSON.stringify({
      query:
        'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){object(expression:"HEAD:file"){... on Blob{text}}}}',
      variables: { owner, name },
    })
  ),
});
async function credential(request: GitHubTaskRequest, identity = auth) {
  const decision = authorizeGitHubTaskRequest(request, grant);
  if (!decision.allowed) return decision;
  return authorizeGitHubTaskCredential(env, tokens, identity, grant, decision, request.url);
}

beforeEach(() => {
  vi.clearAllMocks();
  tokens.getToken.mockResolvedValue('trusted-org-installation-token');
  tokens.getTokenForRepositoryIds.mockResolvedValue('scoped-installation-token');
  fetchMock.mockReset().mockImplementation(async (input: string, init: RequestInit) => {
    const path = new URL(input).pathname;
    const headers = new Headers(init.headers);
    if (path === '/repos/acme/current')
      return Response.json({ ...repo(101, 'acme', 'current'), node_id: 'R_current' });
    if (path === '/repos/acme/sibling') return Response.json(repo(202, 'acme', 'sibling'));
    // The connected identity can read this private repository. The org worktree must never use it here.
    if (path === '/repos/personal-user/private')
      return headers.has('authorization')
        ? Response.json(repo(303, 'personal-user', 'private'))
        : new Response(null, { status: 404 });
    if (path === '/repos/public-owner/public')
      return Response.json(repo(404, 'public-owner', 'public', false));
    if (path.endsWith('/token/scoped'))
      return Response.json({
        token: 'owner-scoped-user-token',
        installation: { repository_selection: 'selected' },
      });
    throw new Error('Unexpected synthetic GitHub request');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('connected identity isolation for organization worktrees', () => {
  it.each([
    { method: 'GET', url: 'https://api.github.com/repos/personal-user/private/contents/file' },
    { method: 'GET', url: 'https://api.github.com/repos/personal-user/private/zipball/main' },
    {
      method: 'GET',
      url: 'https://github.com/personal-user/private.git/info/refs?service=git-upload-pack',
    },
    { method: 'POST', url: 'https://github.com/personal-user/private.git/git-upload-pack' },
    {
      method: 'POST',
      url: 'https://github.com/personal-user/private.git/info/lfs/objects/batch',
      contentType: 'application/vnd.git-lfs+json',
      body: new TextEncoder().encode(
        JSON.stringify({ operation: 'download', objects: [{ oid: 'a'.repeat(64), size: 17 }] })
      ),
    },
    graphql('personal-user', 'private'),
  ])('denies personal private access through $method $url', async request => {
    await expect(credential(request)).rejects.toMatchObject({ reason: 'repository_mismatch' });
    const foreign = fetchMock.mock.calls.filter(([url]) =>
      new URL(url).pathname.startsWith('/repos/personal-user/')
    );
    expect(foreign).toHaveLength(1);
    expect(new Headers(foreign[0][1].headers).has('authorization')).toBe(false);
    expect(
      fetchMock.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/token/scoped'))
    ).toBe(false);
  });

  it.each([
    'https://api.github.com/repos/acme/sibling/contents/file',
    'https://github.com/acme/sibling.git/git-upload-pack',
  ])('permits same-owner private reads with owner-scoped credentials: %s', async url => {
    expect(
      await credential({ method: url.includes('git-upload-pack') ? 'POST' : 'GET', url })
    ).toBe('owner-scoped-user-token');
    expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body)).toEqual({
      access_token: 'ambient-personal-token',
      target: 'acme',
      repository_ids: [101, 202],
    });
  });
  it('keeps write credentials restricted to the current repository and allows the default branch', async () => {
    expect(
      await credential({
        method: 'POST',
        url: 'https://github.com/acme/current.git/git-receive-pack',
        contentType: 'application/x-git-receive-pack-request',
      })
    ).toBe('owner-scoped-user-token');
    expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body)).toEqual({
      access_token: 'ambient-personal-token',
      target: 'acme',
      repository_ids: [101],
    });
  });
  it('never redeems write credentials for another repository, including public ones', async () => {
    for (const target of ['acme/sibling', 'personal-user/private', 'public-owner/public']) {
      expect(
        await credential({
          method: 'POST',
          url: `https://api.github.com/repos/${target}/issues`,
          contentType: 'application/json',
          body: new TextEncoder().encode('{"title":"Issue"}'),
        })
      ).toEqual({ allowed: false, reason: 'repository_mismatch' });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('returns no authorization for foreign public REST and Git reads', async () => {
    for (const url of [
      'https://api.github.com/repos/public-owner/public/contents/file',
      'https://github.com/public-owner/public.git/git-upload-pack',
    ]) {
      expect(
        await credential({ method: url.includes('git-upload-pack') ? 'POST' : 'GET', url })
      ).toBeNull();
    }
    expect(
      fetchMock.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/token/scoped'))
    ).toBe(false);
  });
  it('keeps GraphQL authentication inside the org even when reading a public repository', async () => {
    expect(await credential(graphql('public-owner', 'public'))).toBe('owner-scoped-user-token');
    expect(JSON.parse(fetchMock.mock.calls.at(-1)?.[1].body)).toEqual({
      access_token: 'ambient-personal-token',
      target: 'acme',
      repository_ids: [101],
    });
  });
  it('uses the same installation for sibling reads and narrows the forwarded credential by IDs', async () => {
    const identity = {
      ...auth,
      source: 'installation' as const,
      githubToken: 'current-repository-token',
    };
    expect(
      await credential(
        { method: 'GET', url: 'https://api.github.com/repos/acme/sibling/contents/file' },
        identity
      )
    ).toBe('scoped-installation-token');
    expect(tokens.getToken).toHaveBeenCalledWith('123', 'standard');
    expect(tokens.getTokenForRepositoryIds).toHaveBeenCalledWith('123', [101, 202], 'standard');
  });
});
