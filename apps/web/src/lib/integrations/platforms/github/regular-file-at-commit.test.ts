import { fetchGitHubRegularFileAtCommit } from './regular-file-at-commit';

const COMMIT_SHA = 'c'.repeat(40);
const ROOT = '/repos/acme/guidelines/git/trees/' + COMMIT_SHA;
const DOCS_TREE = '/repos/acme/guidelines/git/trees/' + 'd'.repeat(40);

type Route = { status?: number; body: unknown };

function tree(entries: Array<Record<string, unknown>>, truncated = false) {
  return { body: { sha: 'x'.repeat(40), tree: entries, truncated } };
}

function blob(content: string) {
  return { body: { encoding: 'base64', content: Buffer.from(content).toString('base64') } };
}

let routes: Record<string, Route>;
let requested: string[];

beforeEach(() => {
  requested = [];
  routes = {};
  jest.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    requested.push(url.pathname);
    const route = routes[url.pathname] ?? { status: 404, body: { message: 'Not Found' } };
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

function fetchFile(path: string) {
  return fetchGitHubRegularFileAtCommit({
    token: 'synthetic-token',
    owner: 'acme',
    repo: 'guidelines',
    commitSha: COMMIT_SHA,
    path,
  });
}

it('walks real directories and reads a regular file blob by SHA', async () => {
  routes[ROOT] = tree([{ path: 'docs', mode: '040000', type: 'tree', sha: 'd'.repeat(40) }]);
  routes[DOCS_TREE] = tree([
    { path: 'api.md', mode: '100644', type: 'blob', sha: 'b'.repeat(40), size: 10 },
  ]);
  routes['/repos/acme/guidelines/git/blobs/' + 'b'.repeat(40)] = blob('API rules.');

  await expect(fetchFile('docs/api.md')).resolves.toBe('API rules.');
  expect(requested).toEqual([
    ROOT,
    DOCS_TREE,
    '/repos/acme/guidelines/git/blobs/' + 'b'.repeat(40),
  ]);
});

it('reads executable regular files', async () => {
  routes[ROOT] = tree([
    { path: 'policy.md', mode: '100755', type: 'blob', sha: 'b'.repeat(40), size: 5 },
  ]);
  routes['/repos/acme/guidelines/git/blobs/' + 'b'.repeat(40)] = blob('Rules');

  await expect(fetchFile('policy.md')).resolves.toBe('Rules');
});

it('does not follow a markdown symlink to another file', async () => {
  routes[ROOT] = tree([
    { path: 'secrets.md', mode: '120000', type: 'blob', sha: 'e'.repeat(40), size: 4 },
    { path: '.env', mode: '100644', type: 'blob', sha: 'f'.repeat(40), size: 20 },
  ]);

  await expect(fetchFile('secrets.md')).resolves.toBeNull();
  expect(requested).toEqual([ROOT]);
});

it('does not follow a symlinked directory on the path', async () => {
  routes[ROOT] = tree([{ path: 'docs', mode: '120000', type: 'blob', sha: 'e'.repeat(40) }]);

  await expect(fetchFile('docs/api.md')).resolves.toBeNull();
  expect(requested).toEqual([ROOT]);
});

it.each([
  { path: 'policy.md', mode: '160000', type: 'commit', sha: 'e'.repeat(40) },
  { path: 'policy.md', mode: '040000', type: 'tree', sha: 'e'.repeat(40) },
  { path: 'policy.md', mode: '100644', type: 'blob', sha: 'e'.repeat(40), size: 1_000_001 },
])('returns null for a non-readable entry: %j', async entry => {
  routes[ROOT] = tree([entry]);

  await expect(fetchFile('policy.md')).resolves.toBeNull();
  expect(requested).toEqual([ROOT]);
});

it('returns null for missing entries and missing trees', async () => {
  routes[ROOT] = tree([]);
  await expect(fetchFile('docs/api.md')).resolves.toBeNull();

  delete routes[ROOT];
  await expect(fetchFile('policy.md')).resolves.toBeNull();
});

it('fails when a truncated tree hides the requested entry', async () => {
  routes[ROOT] = tree([], true);

  await expect(fetchFile('policy.md')).rejects.toThrow('GitHub tree listing truncated');
});

it('propagates access failures', async () => {
  routes[ROOT] = { status: 403, body: { message: 'Forbidden' } };

  await expect(fetchFile('policy.md')).rejects.toMatchObject({ status: 403 });
});
