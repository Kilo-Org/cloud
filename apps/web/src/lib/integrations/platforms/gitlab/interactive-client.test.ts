jest.mock('./credential-broker-client', () => ({ fetchGitLabCredential: jest.fn() }));

import { GitbeakerRequestError } from '@gitbeaker/requester-utils';
import type { Gitlab } from '@gitbeaker/rest';
import { buildSchema, graphql } from 'graphql';
import { fetchGitLabCredential } from './credential-broker-client';
import { createGitLabInteractiveClient, GitLabInteractiveError } from './interactive-client';

const credential = jest.mocked(fetchGitLabCredential);
const mockFetch = jest.fn();
const instanceUrl = 'https://gitlab.com/gitlab';
const projectUrl = `${instanceUrl}/api/v4/projects/123`;
const token = 'server-only-test-token';
const actor = { userId: 'oauth/user', organizationId: 'org' };
const selector = {
  credential: 'integration',
  integrationId: '11111111-1111-4111-8111-111111111111',
} as const;

function client(overrides: Partial<Parameters<typeof createGitLabInteractiveClient>[0]> = {}) {
  return createGitLabInteractiveClient({
    actor,
    selector,
    instanceUrl,
    scope: { kind: 'project', projectId: '123' },
    ...overrides,
  });
}

beforeEach(() => {
  global.fetch = mockFetch;
  mockFetch.mockReset();
  credential.mockReset();
  credential.mockResolvedValue({ status: 'available', token, instanceUrl, glabIsOAuth2: true });
});

it('uses Gitbeaker discovery without losing nested paths or default branches', async () => {
  const projects = [
    { id: 123, path_with_namespace: 'Group/Subgroup/project', default_branch: 'release/next' },
  ];
  mockFetch.mockResolvedValueOnce(Response.json(projects));
  const result = await client({ scope: { kind: 'discovery' } }).execute(api =>
    api.Projects.all({ membership: true })
  );
  expect(result).toMatchObject({ status: 200, data: projects });
});

it('preserves a nested project path and the authorized instance subpath in SDK requests', async () => {
  let requestedPath = '';
  mockFetch.mockImplementationOnce(async destination => {
    requestedPath = new URL(destination).pathname;
    return Response.json({ id: 123, path_with_namespace: 'Group/Subgroup/project' });
  });
  const result = await client({
    scope: { kind: 'project', projectId: 'Group/Subgroup/project' },
  }).execute(api => api.Projects.show('Group/Subgroup/project'));
  expect(result.data).toMatchObject({ id: 123 });
  expect(requestedPath).toBe('/gitlab/api/v4/projects/Group%2FSubgroup%2Fproject');
});

it('returns an empty collection without fabricating rows or errors', async () => {
  mockFetch.mockResolvedValueOnce(Response.json([]));
  await expect(client().execute(api => api.Branches.all(123))).resolves.toMatchObject({
    status: 200,
    data: [],
  });
});

it('keeps a created comment distinct from a read response and preserves SHA fields', async () => {
  mockFetch.mockImplementationOnce(async (_destination, init) => {
    const body = JSON.parse(init.body);
    return Response.json(
      { id: 88, body: body.body, diff_sha: body.merge_request_diff_sha },
      { status: 201 }
    );
  });
  const result = await client().execute(api =>
    api.MergeRequestNotes.create(123, 7, 'Review text', { mergeRequestDiffSha: 'expected-head' })
  );
  expect(result).toMatchObject({
    status: 201,
    data: { id: 88, body: 'Review text', diff_sha: 'expected-head' },
  });
});

it('retains a 202 task and its progress instead of reporting a confirmed merge', async () => {
  const location = `${projectUrl}/merge_requests/7/rebase/tasks/9`;
  mockFetch.mockResolvedValueOnce(
    Response.json({ rebase_in_progress: true }, { status: 202, headers: { location } })
  );
  const result = await client().execute(api => api.MergeRequests.rebase(123, 7));
  expect(result).toMatchObject({
    status: 202,
    data: { rebase_in_progress: true },
    headers: { location },
  });
});

it('retains 204 success with null data and never parses an absent body', async () => {
  mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await expect(client().execute(api => api.Branches.remove(123, 'topic'))).resolves.toEqual({
    status: 204,
    data: null,
    headers: {},
  });
});

it('passes a bounded JSON diff through the SDK without changing its positions', async () => {
  const diffs = [{ old_path: 'old.ts', new_path: 'new.ts', diff: '@@ -1 +1 @@\n-old\n+new' }];
  mockFetch.mockResolvedValueOnce(Response.json(diffs));
  await expect(client().execute(api => api.MergeRequests.allDiffs(123, 7))).resolves.toMatchObject({
    status: 200,
    data: diffs,
  });
});

describe.each([
  'text/plain; charset=utf-8',
  'text/x-diff',
  'text/x-patch',
  'application/octet-stream',
])('raw diff with %s', contentType => {
  it.each([false, true])('returns the diff with stream=%s', async asStream => {
    const diff = 'diff --git a/a.ts b/a.ts\n@@ -1 +1 @@\n-a\n+b';
    mockFetch.mockResolvedValueOnce(
      new Response(diff, { headers: { 'content-type': contentType } })
    );
    const result = await client().rawDiff(7, asStream);
    expect(result.status).toBe(200);
    if (asStream) {
      expect(result.data).toBeInstanceOf(ReadableStream);
      expect(await new Response(result.data).text()).toBe(diff);
    } else {
      expect(result.data).toBe(diff);
    }
  });
});

it('keeps immutable file refs and text content through Gitbeaker', async () => {
  mockFetch.mockImplementationOnce(async destination => {
    const url = new URL(destination);
    return new Response(
      url.searchParams.get('ref') === 'immutable-sha' ? 'original content' : 'wrong revision',
      { headers: { 'content-type': 'text/plain' } }
    );
  });
  await expect(
    client().execute(api => api.RepositoryFiles.showRaw(123, 'src/a.ts', 'immutable-sha'))
  ).resolves.toMatchObject({ status: 200, data: 'original content' });
});

it.each([false, true])('preserves binary raw file bytes with stream=%s', async asStream => {
  const bytes = new Uint8Array([0, 255, 13, 10, 123]);
  mockFetch.mockResolvedValueOnce(
    new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } })
  );
  const result = await client().execute(api =>
    api.RepositoryFiles.showRaw(123, 'raw_diffs', 'immutable-sha', { asStream })
  );
  expect(result.status).toBe(200);
  expect(result.data).toBeInstanceOf(asStream ? ReadableStream : Blob);
  expect(new Uint8Array(await new Response(result.data).arrayBuffer())).toEqual(bytes);
});

it.each(['raw', 'raw_diffs'])('reads the branch named %s as JSON', async name => {
  const branch = { name, commit: { id: 'immutable-sha' } };
  mockFetch.mockResolvedValueOnce(Response.json(branch));
  await expect(client().execute(api => api.Branches.show(123, name))).resolves.toMatchObject({
    status: 200,
    data: branch,
  });
});

it.each(['raw', 'raw_diffs'])('reads the file named %s as JSON', async filePath => {
  const file = { file_path: filePath, content: 'Y29udGVudA==', encoding: 'base64' };
  mockFetch.mockResolvedValueOnce(Response.json(file));
  await expect(
    client().execute(api => api.RepositoryFiles.show(123, filePath, 'immutable-sha'))
  ).resolves.toMatchObject({ status: 200, data: file });
});

it.each([
  'query { project(fullPath: "Other/project") { id } }',
  'query { node(id: "gid://gitlab/Project/124") { id } }',
  'mutation { mergeRequestRequestChanges(input: { projectPath: "Other/project", iid: "7" }) { mergeRequest { id } } }',
])('rejects cross-project GraphQL before credential access: %s', async query => {
  mockFetch.mockResolvedValueOnce(Response.json({ data: { id: 'gid://gitlab/Project/124' } }));
  await expect(
    client().execute(api =>
      (api as InstanceType<typeof Gitlab>).requester.post(`${instanceUrl}/api/graphql`, {
        body: { query },
      })
    )
  ).rejects.toMatchObject({ code: 'unsafe_url' });
  expect(credential).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each(['123', 'Group/Subgroup/project'])(
  'requests changes only in the authorized project %s',
  async projectId => {
    // The documented mutation requires a full project path and a string IID.
    const schema = buildSchema(`
      type Query { unused: Boolean }
      input MergeRequestRequestChangesInput { projectPath: ID!, iid: String! }
      type MergeRequest { id: ID!, iid: String! }
      type RequestChangesPayload { mergeRequest: MergeRequest, errors: [String!]! }
      type Mutation {
        mergeRequestRequestChanges(input: MergeRequestRequestChangesInput!): RequestChangesPayload
      }
    `);
    const reviews = new Map([
      ['Group/Subgroup/project#7', 'unreviewed'],
      ['Other/project#7', 'unreviewed'],
    ]);
    mockFetch.mockImplementation(async (destination, init) => {
      const path = new URL(destination).pathname;
      if (path === '/gitlab/api/v4/projects/123' && init.method === 'GET')
        return Response.json({ id: 123, path_with_namespace: 'Group/Subgroup/project' });
      if (path !== '/gitlab/api/graphql' || init.method !== 'POST')
        return Response.json({}, { status: 404 });
      const body = JSON.parse(init.body);
      return Response.json(
        await graphql({
          schema,
          source: body.query,
          variableValues: body.variables,
          rootValue: {
            mergeRequestRequestChanges: ({
              input,
            }: {
              input: { projectPath: string; iid: string };
            }) => {
              const key = `${input.projectPath}#${input.iid}`;
              if (!reviews.has(key)) return { mergeRequest: null, errors: ['Not found'] };
              reviews.set(key, 'requested_changes');
              return {
                mergeRequest: { id: 'gid://gitlab/MergeRequest/88', iid: input.iid },
                errors: [],
              };
            },
          },
        })
      );
    });
    const result = await client({ scope: { kind: 'project', projectId } }).requestChanges(7);
    expect(result).toMatchObject({
      status: 200,
      data: {
        data: {
          mergeRequestRequestChanges: {
            mergeRequest: { id: 'gid://gitlab/MergeRequest/88', iid: '7' },
            errors: [],
          },
        },
      },
    });
    expect(reviews.get('Group/Subgroup/project#7')).toBe('requested_changes');
    expect(reviews.get('Other/project#7')).toBe('unreviewed');
  }
);

it.each([
  { id: 124, path_with_namespace: 'Other/project' },
  { id: 123, path_with_namespace: '' },
  { id: 123 },
])('rejects an unusable project identity before a GraphQL write: %j', async project => {
  let writes = 0;
  mockFetch.mockImplementation(async (_destination, init) => {
    if (init.method === 'POST') writes++;
    return Response.json(project);
  });
  await expect(client().requestChanges(7)).rejects.toMatchObject({ code: 'invalid_response' });
  expect(writes).toBe(0);
});

it('shares the response limit between project resolution and the GraphQL write', async () => {
  mockFetch
    .mockResolvedValueOnce(
      Response.json({
        id: 123,
        path_with_namespace: 'Group/Subgroup/project',
        description: 'x'.repeat(6 * 1024 * 1024),
      })
    )
    .mockResolvedValueOnce(Response.json({ data: { detail: 'x'.repeat(6 * 1024 * 1024) } }));
  await expect(client().requestChanges(7)).rejects.toMatchObject({ code: 'response_too_large' });
});

it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
  'rejects invalid request-changes IID %s before credential access',
  async iid => {
    await expect(client().requestChanges(iid)).rejects.toMatchObject({ code: 'invalid_request' });
    expect(credential).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  }
);

it('rejects request-changes from discovery before credential access', async () => {
  await expect(client({ scope: { kind: 'discovery' } }).requestChanges(7)).rejects.toMatchObject({
    code: 'invalid_request',
  });
  expect(credential).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each([429, 502])('does not retry a request-changes write after HTTP %s', async status => {
  let writes = 0;
  mockFetch.mockImplementation(async () => {
    writes++;
    return Response.json({ message: token }, { status, headers: { 'retry-after': '0' } });
  });
  await expect(
    client({ scope: { kind: 'project', projectId: 'Group/Subgroup/project' } }).requestChanges(7)
  ).rejects.toMatchObject({ status, code: 'temporarily_unavailable' });
  expect(writes).toBe(1);
});

it('accepts review text above the old internal limit without truncation', async () => {
  const body = 'é'.repeat(65_536);
  mockFetch.mockImplementationOnce(async (_destination, init) =>
    Response.json({ id: 1, body: JSON.parse(init.body).body }, { status: 201 })
  );
  await expect(
    client().execute(api => api.MergeRequestNotes.create(123, 7, body))
  ).resolves.toMatchObject({ status: 201, data: { id: 1, body } });
});

it('rejects oversized serialized text before even requesting a credential', async () => {
  await expect(
    client().execute(api => api.MergeRequestNotes.create(123, 7, 'é'.repeat(128_000)))
  ).rejects.toMatchObject({ code: 'request_too_large' });
  expect(credential).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each([401, 403, 429, 502])('does not retry a write after HTTP %s', async status => {
  let attempts = 0;
  mockFetch.mockImplementation(async () => {
    attempts++;
    return Response.json({ message: token }, { status, headers: { 'retry-after': '0' } });
  });
  await expect(
    client().execute(api => api.MergeRequestNotes.create(123, 7, 'one effect'))
  ).rejects.toMatchObject({ status });
  expect(attempts).toBe(1);
});

it.each([303, 307])('does not replay an SDK mutation on redirect %s', async status => {
  let attempts = 0;
  mockFetch.mockImplementation(async () => {
    attempts++;
    return attempts === 1
      ? new Response(null, {
          status,
          headers: { location: `${projectUrl}/merge_requests/7/notes` },
        })
      : Response.json({ id: 2 }, { status: 201 });
  });
  await expect(
    client().execute(api => api.MergeRequestNotes.create(123, 7, 'one effect'))
  ).rejects.toMatchObject({ code: 'redirect' });
  expect(attempts).toBe(1);
});

it('redacts SDK errors and leaves a lost write response for ledger reconciliation', async () => {
  let effects = 0;
  mockFetch.mockImplementationOnce(async () => {
    effects++;
    throw new GitbeakerRequestError(token, {
      cause: {
        description: token,
        request: new Request(projectUrl, { headers: { Authorization: `Bearer ${token}` } }),
        response: Response.json({ token }),
      },
    });
  });
  const error = await client()
    .execute(api => api.MergeRequestNotes.create(123, 7, 'one effect'))
    .catch((error: unknown) => error);
  expect(error).toBeInstanceOf(GitLabInteractiveError);
  expect(error).toMatchObject({ code: 'temporarily_unavailable' });
  expect(error).not.toHaveProperty('cause');
  expect(error).not.toHaveProperty('request');
  expect(error).not.toHaveProperty('response');
  expect(`${String(error)}${JSON.stringify(error)}`).not.toContain(token);
  expect(effects).toBe(1);
});

it.each([
  'not_connected',
  'reconnect_required',
  'temporarily_unavailable',
  'invalid_request',
] as const)('retains the broker status %s without provider access', async status => {
  credential.mockResolvedValueOnce({ status });
  await expect(client().execute(api => api.Projects.show(123))).rejects.toMatchObject({
    code: status,
  });
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each(['https://evil.example/gitlab', 'https://gitlab.com/other', 'https://gitlab.com'])(
  'rejects a credential for a different authorized instance: %s',
  async changedInstance => {
    credential.mockResolvedValueOnce({
      status: 'available',
      token,
      instanceUrl: changedInstance,
      glabIsOAuth2: false,
    });
    await expect(client().execute(api => api.Projects.show(123))).rejects.toMatchObject({
      code: 'unsafe_url',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  }
);

it('rejects a different project before requesting credentials', async () => {
  await expect(client().execute(api => api.Projects.show(124))).rejects.toMatchObject({
    code: 'unsafe_url',
  });
  expect(credential).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it('cannot use a project credential under a different project scope', async () => {
  await expect(
    client({ selector: { ...selector, credential: 'project-exact', projectId: '124' } }).execute(
      api => api.Projects.show(123)
    )
  ).rejects.toMatchObject({ code: 'forbidden' });
  expect(credential).not.toHaveBeenCalled();
});

it('blocks writes from discovery and prevents provider actor impersonation', async () => {
  await expect(
    client({ scope: { kind: 'discovery' } }).execute(api =>
      api.MergeRequestNotes.create(123, 7, 'text')
    )
  ).rejects.toMatchObject({ code: 'unsafe_url' });
  await expect(client().execute(api => api.Projects.show(123, { sudo: 9 }))).rejects.toMatchObject({
    code: 'forbidden',
  });
  expect(mockFetch).not.toHaveBeenCalled();
});

it('uses broker-refreshed credentials for each bounded page', async () => {
  credential.mockResolvedValueOnce({
    status: 'available',
    token: 'old-token',
    instanceUrl,
    glabIsOAuth2: true,
  });
  credential.mockResolvedValueOnce({
    status: 'available',
    token: 'new-token',
    instanceUrl,
    glabIsOAuth2: true,
  });
  let pages = 0;
  mockFetch.mockImplementation(async (destination, init) => {
    pages++;
    const page = new URL(destination).searchParams.get('page') ?? '1';
    const expected = page === '1' ? 'old-token' : 'new-token';
    if (new Headers(init.headers).get('authorization') !== `Bearer ${expected}`)
      return Response.json({}, { status: 401 });
    return Response.json([{ id: Number(page) }], {
      headers:
        page === '1'
          ? {
              link: `<${projectUrl}/merge_requests?state=opened&per_page=1&page=2>; rel="next"`,
            }
          : {},
    });
  });
  const result = await client().execute(api =>
    api.MergeRequests.all({ projectId: 123, state: 'opened', perPage: 1 })
  );
  expect(result.data).toEqual([{ id: 1 }, { id: 2 }]);
  expect(pages).toBe(2);
});

it.each([
  `https://evil.example/gitlab/api/v4/projects/123/merge_requests?state=opened&page=2`,
  `${instanceUrl}/api/v4/projects/124/merge_requests?state=opened&page=2`,
  `${projectUrl}/merge_requests?state=closed&page=2`,
  `https://gitlab.com/api/v4/projects/123/merge_requests?state=opened&page=2`,
])('rejects a next link outside the origin or resource scope: %s', async next => {
  mockFetch.mockResolvedValueOnce(
    Response.json([{ id: 1 }], { headers: { link: `<${next}>; rel="next"` } })
  );
  await expect(
    client().execute(api => api.MergeRequests.all({ projectId: 123, state: 'opened' }))
  ).rejects.toMatchObject({ code: 'unsafe_url' });
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it('stops endless SDK pagination at 100 provider requests', async () => {
  let pages = 0;
  mockFetch.mockImplementation(async () => {
    pages++;
    return Response.json([{ id: pages }], {
      headers: { link: `<${projectUrl}/merge_requests?per_page=1&page=${pages + 1}>; rel="next"` },
    });
  });
  await expect(
    client().execute(api => api.MergeRequests.all({ projectId: 123, perPage: 1 }))
  ).rejects.toMatchObject({ code: 'pagination_limit' });
  expect(pages).toBe(100);
});

it('bounds the combined response across SDK pages', async () => {
  let pages = 0;
  mockFetch.mockImplementation(async () => {
    pages++;
    return Response.json([{ id: pages, body: 'x'.repeat(6 * 1024 * 1024) }], {
      headers: { link: `<${projectUrl}/merge_requests?per_page=1&page=${pages + 1}>; rel="next"` },
    });
  });
  await expect(
    client().execute(api => api.MergeRequests.all({ projectId: 123, perPage: 1 }))
  ).rejects.toMatchObject({ code: 'response_too_large' });
  expect(pages).toBe(2);
});

it.each([{ userId: 'oauth/personal' }, actor])(
  'uses the supplied server actor and integration: %j',
  async expectedActor => {
    credential.mockImplementation(async (actualActor, actualSelector) => {
      if (
        actualActor.userId !== expectedActor.userId ||
        actualActor.organizationId !==
          ('organizationId' in expectedActor ? expectedActor.organizationId : undefined) ||
        actualSelector.integrationId !== selector.integrationId
      )
        return { status: 'not_connected' };
      return { status: 'available', token, instanceUrl, glabIsOAuth2: true };
    });
    mockFetch.mockResolvedValueOnce(Response.json({ id: 9, username: 'integration-actor' }));
    await expect(
      client({ actor: expectedActor }).execute(api => api.Users.showCurrentUser())
    ).resolves.toMatchObject({ status: 200, data: { id: 9, username: 'integration-actor' } });
  }
);

it('reads the authorized instance version through the SDK metadata operation', async () => {
  mockFetch.mockResolvedValueOnce(Response.json({ version: '17.11.0', enterprise: true }));
  await expect(client().execute(api => api.Metadata.show())).resolves.toMatchObject({
    status: 200,
    data: { version: '17.11.0', enterprise: true },
  });
});

it('rejects excessive page sizes before provider access', async () => {
  await expect(
    client().execute(api => api.MergeRequests.all({ projectId: 123, perPage: 101 }))
  ).rejects.toMatchObject({ code: 'invalid_request' });
  expect(mockFetch).not.toHaveBeenCalled();
});

it('rejects a redirect to another project instead of returning that project', async () => {
  mockFetch.mockResolvedValueOnce(
    new Response(null, { status: 302, headers: { location: `${instanceUrl}/api/v4/projects/124` } })
  );
  await expect(client().execute(api => api.Projects.show(123))).rejects.toMatchObject({
    code: 'unsafe_url',
  });
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it('rejects a redirect that changes an immutable file revision', async () => {
  mockFetch.mockResolvedValueOnce(
    new Response(null, {
      status: 302,
      headers: {
        location: `${projectUrl}/repository/files/src%2Fa.ts/raw?ref=other-sha`,
      },
    })
  );
  await expect(
    client().execute(api => api.RepositoryFiles.showRaw(123, 'src/a.ts', 'immutable-sha'))
  ).rejects.toMatchObject({ code: 'unsafe_url' });
  expect(mockFetch).toHaveBeenCalledTimes(1);
});

it('posts an inline discussion through the SDK with its exact diff position', async () => {
  const body = 'é'.repeat(65_536);
  mockFetch.mockImplementationOnce(async (destination, init) => {
    const fields = await new Request(destination, init).formData();
    return Response.json(
      {
        id: 'discussion-1',
        notes: [
          {
            id: 1,
            body: fields.get('body'),
            position: {
              position_type: fields.get('position[position_type]'),
              base_sha: fields.get('position[base_sha]'),
              start_sha: fields.get('position[start_sha]'),
              head_sha: fields.get('position[head_sha]'),
              old_path: fields.get('position[old_path]'),
              new_path: fields.get('position[new_path]'),
              new_line: Number(fields.get('position[new_line]')),
            },
          },
        ],
      },
      { status: 201 }
    );
  });
  const result = await client().execute(api =>
    api.MergeRequestDiscussions.create(123, 7, body, {
      position: {
        positionType: 'text',
        baseSha: 'base',
        startSha: 'start',
        headSha: 'head',
        oldPath: 'old.ts',
        newPath: 'new.ts',
        newLine: 2,
      },
    })
  );
  expect(result).toMatchObject({
    status: 201,
    data: {
      id: 'discussion-1',
      notes: [
        {
          id: 1,
          body,
          position: {
            position_type: 'text',
            base_sha: 'base',
            start_sha: 'start',
            head_sha: 'head',
            old_path: 'old.ts',
            new_path: 'new.ts',
            new_line: 2,
          },
        },
      ],
    },
  });
});

it('bounds serialized multipart bodies before credential or provider access', async () => {
  await expect(
    client().execute(api =>
      api.MergeRequestDiscussions.create(123, 7, 'é'.repeat(128_000), {
        position: {
          positionType: 'text',
          baseSha: 'base',
          startSha: 'start',
          headSha: 'head',
          oldPath: 'old.ts',
          newPath: 'new.ts',
          newLine: 2,
        },
      })
    )
  ).rejects.toMatchObject({ code: 'request_too_large' });
  expect(credential).not.toHaveBeenCalled();
  expect(mockFetch).not.toHaveBeenCalled();
});

it.each([
  ['text/html', '{"id":123}'],
  ['application/json', 'not json'],
  ['application/json', 'true'],
])('rejects unusable JSON responses with content type %s', async (contentType, body) => {
  mockFetch.mockResolvedValueOnce(new Response(body, { headers: { 'content-type': contentType } }));
  await expect(client().execute(api => api.Projects.show(123))).rejects.toMatchObject({
    code: 'invalid_response',
  });
});

it.each([
  { kind: 'diff', asStream: false },
  { kind: 'diff', asStream: true },
  { kind: 'file', asStream: false },
  { kind: 'file', asStream: true },
])('bounds raw $kind responses with stream=$asStream', async ({ kind, asStream }) => {
  mockFetch.mockResolvedValueOnce(
    new Response('x'.repeat(10 * 1024 * 1024 + 1), {
      headers: { 'content-type': 'application/octet-stream', 'private-token': token },
    })
  );
  const response =
    kind === 'diff'
      ? client().rawDiff(7, asStream)
      : client().execute(api =>
          api.RepositoryFiles.showRaw(123, 'raw_diffs', 'immutable-sha', { asStream })
        );
  await expect(response).rejects.toMatchObject({ code: 'response_too_large' });
});

it('returns only allowlisted headers and no credential-bearing response object', async () => {
  mockFetch.mockResolvedValueOnce(
    Response.json(
      { id: 123 },
      { headers: { 'set-cookie': token, 'private-token': token, authorization: token } }
    )
  );
  const result = await client().execute(api => api.Projects.show(123, { showExpanded: true }));
  expect(result.headers).toEqual({ 'content-type': 'application/json' });
  expect(result.data).toMatchObject({
    data: { id: 123 },
    headers: { 'content-type': 'application/json' },
  });
  expect(JSON.stringify(result)).not.toContain(token);
});
