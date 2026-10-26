import { describe, expect, it } from 'vitest';
import {
  githubTaskGrantSchema,
  type GitHubTaskGrant,
} from '@kilocode/worker-utils/github-task-grant';
import { authorizeGitHubTaskRequest, type GitHubTaskRequest } from './github-task-policy.js';

const grant: GitHubTaskGrant = {
  revision: 1,
  scopeId: 'worktree_security_test',
  repository: {
    id: 101,
    nodeId: 'R_fixture_a',
    owner: 'na2-org',
    name: 'cloud-agent-security-test-a',
  },
  taskRef: 'refs/heads/kilo/security-test',
};
const repository = `https://api.github.com/repos/${grant.repository.owner}/${grant.repository.name}`;
const git = `https://github.com/${grant.repository.owner}/${grant.repository.name}.git`;
const bytes = (text: string) => new TextEncoder().encode(text);
const json = (url: string, body: unknown, method = 'POST'): GitHubTaskRequest => ({
  method,
  url,
  contentType: 'application/json',
  body: bytes(JSON.stringify(body)),
});
const authorize = (request: GitHubTaskRequest) => authorizeGitHubTaskRequest(request, grant);
const graphql = (query: string, variables?: Record<string, unknown>) =>
  authorize(json('https://api.github.com/graphql', { query, variables }));
const read = { allowed: true, operation: 'read', checks: [] };
const write = { allowed: true, operation: 'write', checks: [] };

describe('GitHub repository write boundary', () => {
  it.each(['main', 'other', 'kilo/security-test'])(
    'permits Git pushes and PR creation from %s',
    branch => {
      expect(
        authorize({
          method: 'POST',
          url: `${git}/git-receive-pack`,
          contentType: 'application/x-git-receive-pack-request',
          body: bytes(branch),
        })
      ).toEqual(write);
      expect(
        authorize(json(`${repository}/pulls`, { title: 'PR', head: branch, base: 'main' }))
      ).toEqual(write);
      expect(
        graphql(
          'mutation($input:CreatePullRequestInput!){createPullRequest(input:$input){pullRequest{id}}}',
          {
            input: {
              repositoryId: grant.repository.nodeId,
              headRefName: branch,
              baseRefName: 'main',
              title: 'PR',
            },
          }
        )
      ).toEqual(write);
    }
  );

  it.each([
    ['/pulls/42', { title: 'Updated' }, 'PATCH'],
    ['/issues', { title: 'Issue', body: 'Details', labels: ['bug'] }, 'POST'],
    ['/issues/7', { state: 'closed' }, 'PATCH'],
    ['/issues/7/comments', { body: 'Issue or PR comment' }, 'POST'],
    ['/issues/comments/9', { body: 'Edited comment' }, 'PATCH'],
    ['/pulls/7/reviews', { event: 'APPROVE', body: 'Reviewed' }, 'POST'],
    ['/pulls/7/reviews', { event: 'COMMENT', body: 'Reviewed' }, 'POST'],
    [
      '/pulls/7/comments',
      { body: 'Inline', path: 'index.ts', line: 3, commit_id: 'a'.repeat(40) },
      'POST',
    ],
    ['/pulls/7/comments/9/replies', { body: 'Reply' }, 'POST'],
  ])('allows repository workflow writes to %s', (path, body, method) => {
    expect(authorize(json(`${repository}${path}`, body, method))).toEqual(write);
    expect(
      authorize(json(`${repository.replace('test-a', 'test-b')}${path}`, body, method)).allowed
    ).toBe(false);
    expect(
      authorize(json(`${repository.replace('na2-org', 'personal-user')}${path}`, body, method))
        .allowed
    ).toBe(false);
  });

  it.each(['na2-org/other', 'personal-user/private', 'public-owner/public'])(
    'denies pushes and receive negotiation to %s',
    target => {
      for (const request of [
        {
          method: 'POST',
          url: `https://github.com/${target}.git/git-receive-pack`,
          contentType: 'application/x-git-receive-pack-request',
        },
        {
          method: 'GET',
          url: `https://github.com/${target}.git/info/refs?service=git-receive-pack`,
        },
      ])
        expect(authorize(request)).toEqual({ allowed: false, reason: 'repository_mismatch' });
    }
  );

  it('checks opaque PR and issue IDs against the current repository', () => {
    expect(
      graphql(
        'mutation($input:UpdatePullRequestInput!){updatePullRequest(input:$input){pullRequest{id}}}',
        {
          input: { pullRequestId: 'PR_other_branch', title: 'Updated' },
        }
      )
    ).toEqual({
      allowed: true,
      operation: 'write',
      checks: [{ kind: 'repository-pull-request-node', nodeId: 'PR_other_branch' }],
    });
    expect(
      graphql(
        'mutation($input:AddCommentInput!){addComment(input:$input){commentEdge{node{id}}}}',
        {
          input: { subjectId: 'I_or_PR', body: 'Comment' },
        }
      )
    ).toEqual({
      allowed: true,
      operation: 'write',
      checks: [{ kind: 'repository-subject-node', nodeId: 'I_or_PR' }],
    });
    expect(
      graphql('mutation($input:UpdateIssueInput!){updateIssue(input:$input){issue{id}}}', {
        input: { id: 'I_current', title: 'Updated' },
      })
    ).toEqual({
      allowed: true,
      operation: 'write',
      checks: [{ kind: 'repository-issue-node', nodeId: 'I_current' }],
    });
  });

  it('allows issue creation only in the selected repository', () => {
    const query = 'mutation($input:CreateIssueInput!){createIssue(input:$input){issue{id title}}}';
    expect(
      graphql(query, { input: { repositoryId: grant.repository.nodeId, title: 'Issue' } })
    ).toEqual(write);
    expect(graphql(query, { input: { repositoryId: 'R_personal', title: 'Issue' } }).allowed).toBe(
      false
    );
  });
});

describe('GitHub repository reads', () => {
  it.each([
    '',
    '/contents/src%2Findex.ts',
    '/pulls/42',
    '/pulls/42/files',
    '/issues/7/comments',
    '/commits/abc/check-runs',
    '/actions/runs/123/jobs',
    '/tarball',
    '/zipball/main',
  ])('allows selected repository read %s', path =>
    expect(authorize({ method: 'GET', url: `${repository}${path}` })).toEqual(read)
  );

  it.each(['na2-org/other', 'personal-user/private', 'public-owner/public'])(
    'requires trusted read authorization for %s across REST, Git, archives and GraphQL',
    target => {
      const [owner, name] = target.split('/');
      const expected = {
        allowed: true,
        operation: 'read',
        checks: [{ kind: 'repository-read', owner, name }],
      };
      for (const request of [
        { method: 'GET', url: `https://api.github.com/repos/${target}/contents/file` },
        { method: 'HEAD', url: `https://api.github.com/repos/${target}/zipball/main` },
        {
          method: 'GET',
          url: `https://github.com/${target}.git/info/refs?service=git-upload-pack`,
        },
        { method: 'POST', url: `https://github.com/${target}.git/git-upload-pack` },
      ])
        expect(authorize(request)).toEqual(expected);
      expect(
        graphql(
          'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){object(expression:"HEAD:file"){... on Blob{text}}}}',
          { owner, name }
        )
      ).toEqual(expected);
    }
  );

  it.each(['orgs', 'users'])('allows discovery only under the current owner through /%s', kind => {
    expect(
      authorize({ method: 'GET', url: `https://api.github.com/${kind}/na2-org/repos` })
    ).toEqual({ allowed: true, operation: 'read', checks: [{ kind: 'owner-read' }] });
    expect(
      authorize({ method: 'GET', url: `https://api.github.com/${kind}/personal-user/repos` })
        .allowed
    ).toBe(false);
  });

  it.each(['organization', 'user'])('limits GraphQL %s discovery to the current owner', field => {
    const query = `query($login:String!){${field}(login:$login){repositories(first:10){nodes{name}}}}`;
    expect(graphql(query, { login: 'na2-org' })).toEqual({
      allowed: true,
      operation: 'read',
      checks: [{ kind: 'owner-read' }],
    });
    expect(graphql(query, { login: 'personal-user' }).allowed).toBe(false);
  });

  it('checks all repository selections, including aliases and skipped fields', () => {
    expect(
      graphql(
        '{repository(owner:"na2-org",name:"cloud-agent-security-test-a"){id} personal:repository(owner:"personal-user",name:"private") @skip(if:true){id}}'
      )
    ).toEqual({
      allowed: true,
      operation: 'read',
      checks: [{ kind: 'repository-read', owner: 'personal-user', name: 'private' }],
    });
  });
});

describe('GitHub LFS repository boundary', () => {
  const object = { oid: 'a'.repeat(64), size: 17 };
  const batchUrl = `${git}/info/lfs/objects/batch`;
  const lfs = (url: string, body: unknown) => ({
    ...json(url, body),
    contentType: 'application/vnd.git-lfs+json; charset=utf-8',
  });
  it.each(['main', 'other'])(
    'allows uploads to any valid branch %s in the current repository',
    branch => {
      const batch = lfs(batchUrl, {
        operation: 'upload',
        objects: [object],
        ref: { name: `refs/heads/${branch}` },
      });
      expect(authorize(batch)).toEqual(write);
      expect(authorize({ ...batch, url: batch.url.replace('test-a', 'test-b') }).allowed).toBe(
        false
      );
    }
  );
  it('checks other-repository download batches and managed downloads as reads', () => {
    for (const request of [
      lfs(batchUrl.replace('test-a', 'test-b'), { operation: 'download', objects: [object] }),
      {
        method: 'GET',
        url: `${git.replace('test-a', 'test-b')}/info/lfs/kilo-download/${object.oid}?size=17`,
      },
    ])
      expect(authorize(request)).toEqual({
        allowed: true,
        operation: 'read',
        checks: [
          { kind: 'repository-read', owner: 'na2-org', name: 'cloud-agent-security-test-b' },
        ],
      });
  });
  it.each([
    { operation: 'upload', objects: [object] },
    { operation: 'download', objects: [object, object] },
    { operation: 'download', objects: [{ ...object, size: -1 }] },
    { operation: 'download', objects: [{ ...object, oid: '../other' }] },
    { operation: 'download', objects: [object], url: 'https://other.example' },
  ])('rejects unsupported LFS input', body =>
    expect(authorize(lfs(batchUrl, body)).allowed).toBe(false)
  );
});

describe('GitHub authorization parsing', () => {
  it.each([
    `${repository}/../other`,
    `${repository}/%2e%2e/other`,
    `${repository}/%252e%252e/other`,
    `${repository}/contents/%5c..%5csecret`,
    `${repository}/contents/%00`,
    `${repository}/contents/%`,
    `${repository}/contents/a#fragment`,
    `${repository}/contents/a\n`,
    `${repository.replace('https:', 'http:')}/contents/a`,
    `${repository.replace('api.github.com', 'api.github.com:8443')}/contents/a`,
    `${repository.replace('api.github.com', 'api.github.com.evil.example')}/contents/a`,
    `${repository.replace('na2-org', 'na2-org%2fother')}/contents/a`,
  ])('rejects unsafe URLs %s', url =>
    expect(authorize({ method: 'GET', url }).allowed).toBe(false)
  );

  it.each([
    '/user/repos',
    '/user/orgs',
    '/repositories/102/contents/file',
    '/search/code?q=private',
    '/orgs/personal-user/repos',
  ])('denies unbounded account reads %s', path =>
    expect(authorize({ method: 'GET', url: `https://api.github.com${path}` }).allowed).toBe(false)
  );
  it.each(['/actions/secrets', '/hooks', '/actions/runners/registration-token'])(
    'denies credential and administrative endpoints %s',
    path => expect(authorize({ method: 'GET', url: `${repository}${path}` }).allowed).toBe(false)
  );
  it.each([
    '{viewer{repositories(first:10){nodes{name}}}}',
    '{node(id:"R_personal"){... on Repository{name}}}',
    '{search(query:"private",type:REPOSITORY,first:10){nodes{... on Repository{name}}}}',
    '{repository(owner:"na2-org",name:"cloud-agent-security-test-a"){owner{... on Organization{repositories(first:10){nodes{name}}}}}}',
    '{repository(owner:"na2-org",name:"cloud-agent-security-test-a"){parent{object(expression:"HEAD:secret"){... on Blob{text}}}}}',
    '{repository(owner:"na2-org",name:"cloud-agent-security-test-a"){pullRequests(first:1000){nodes{id}}}}',
    'query A{viewer{login}} query B{viewer{login}}',
    '{repository(owner:"na2-org",name:"cloud-agent-security-test-a"){...cycle}} fragment cycle on Repository{...cycle}',
  ])('denies alternate GraphQL authority paths %s', query =>
    expect(graphql(query).allowed).toBe(false)
  );

  it('rejects unsupported write fields and mutation URL parameters', () => {
    expect(
      authorize(
        json(`${repository}/pulls`, {
          title: 'PR',
          head: 'main',
          base: 'other',
          head_repo: 'other',
        })
      ).allowed
    ).toBe(false);
    expect(
      authorize(json(`${repository}/issues?access_token=synthetic`, { title: 'Issue' })).allowed
    ).toBe(false);
    expect(
      authorize({ ...json(`${repository}/issues`, { title: 'Issue' }), contentType: 'text/plain' })
        .allowed
    ).toBe(false);
  });
  it.each(['refs/heads/a..b', 'refs/heads/.hidden', 'refs/heads/a b', 'refs/heads/a.lock'])(
    'still validates persisted task metadata %s',
    taskRef => expect(githubTaskGrantSchema.safeParse({ ...grant, taskRef }).success).toBe(false)
  );
});
