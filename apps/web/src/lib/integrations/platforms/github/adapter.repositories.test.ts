jest.mock('@/lib/utils.server', () => ({
  logExceptInTest: jest.fn(),
  warnExceptInTest: jest.fn(),
}));
jest.mock('./app-selector', () => ({
  getGitHubAppCredentials: (app: string) => ({
    appId: app === 'lite' ? '456' : '123',
    privateKey: mockPrivateKey,
  }),
}));

import { generateKeyPairSync } from 'node:crypto';
import { fetchGitHubRepositories } from './adapter';

const mockPrivateKey = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();
const repo = {
  id: 7,
  name: 'repo',
  full_name: 'owner/repo',
  private: true,
  archived: false,
  created_at: '2026-01-01T00:00:00Z',
};
const fetchMock = jest.spyOn(globalThis, 'fetch');
let pages: string[];
let appId: string;
let pageResponse: (url: URL) => Response | Promise<Response>;

beforeEach(() => {
  pages = [];
  appId = '';
  pageResponse = url =>
    Response.json({
      repositories: Array.from(
        {
          length:
            url.searchParams.get('page') === '3' ? 1 : Number(url.searchParams.get('per_page')),
        },
        () => ({ ...repo, archived: url.searchParams.get('page') === '1' })
      ),
    });
  fetchMock.mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    if (url.pathname.endsWith('/access_tokens')) {
      appId = JSON.parse(Buffer.from(authorization.split('.')[1], 'base64url').toString()).iss;
      return Response.json({
        token: 'installation-token',
        expires_at: '2099-01-01T00:00:00Z',
        permissions: {},
        repository_selection: 'all',
      });
    }
    if (authorization !== 'token installation-token')
      return Response.json({ message: 'Bad credentials' }, { status: 401 });
    pages.push(url.search);
    return pageResponse(url);
  });
});
afterAll(() => fetchMock.mockRestore());
afterEach(() => jest.useRealTimers());

it.each([undefined, { bounded: true }])(
  'preserves auth and paging with options %j',
  async options => {
    const result = await fetchGitHubRepositories('42', options ? 'lite' : undefined, options);
    expect(result).toHaveLength(options ? 50 : 101);
    expect(result[0]).toEqual({
      id: 7,
      name: 'repo',
      full_name: 'owner/repo',
      private: true,
      created_at: repo.created_at,
    });
    expect(appId).toBe(options ? '456' : '123');
    expect(pages).toHaveLength(options ? 2 : 3);
    expect(pages[0]).toContain(`per_page=${options ? 50 : 100}`);
  }
);

it('stops after two archived-only pages', async () => {
  pageResponse = () =>
    Response.json({
      repositories: Array.from({ length: 50 }, () => ({ ...repo, archived: true })),
    });
  await expect(fetchGitHubRepositories('42', 'standard', { bounded: true })).resolves.toEqual([]);
  expect(pages).toHaveLength(2);
});

it.each([
  {},
  { repositories: [null] },
  { repositories: Array(51).fill(repo) },
  'invalid json',
  { repositories: [{ ...repo, name: 'x'.repeat(1048577) }] },
])('rejects invalid provider data %#', async data => {
  pageResponse = () =>
    typeof data === 'string'
      ? new Response(data, { headers: { 'content-type': 'application/json' } })
      : Response.json(data);
  await expect(fetchGitHubRepositories('42', 'standard', { bounded: true })).rejects.toThrow();
});

it('preserves provider errors and permits a fresh empty read', async () => {
  pageResponse = () => Response.json({ message: 'Provider unavailable' }, { status: 503 });
  await expect(fetchGitHubRepositories('42')).rejects.toThrow('Provider unavailable');
  await expect(fetchGitHubRepositories('42', 'standard', { bounded: true })).rejects.toThrow(
    'Provider unavailable'
  );
  pageResponse = () => Response.json({ repositories: [] });
  await expect(fetchGitHubRepositories('42', 'standard', { bounded: true })).resolves.toEqual([]);
});

it('includes installation authentication in the deadline', async () => {
  jest.useFakeTimers();
  const started = Promise.withResolvers<AbortSignal>();
  fetchMock.mockImplementation((_url, init) => {
    started.resolve(init?.signal as AbortSignal);
    return new Promise(() => {});
  });
  const result = fetchGitHubRepositories('42', 'lite', { bounded: true });
  const rejection = expect(result).rejects.toThrow('Repository fetch timed out');
  const signal = await started.promise;
  await jest.advanceTimersByTimeAsync(30_000);
  await rejection;
  expect(signal.aborted).toBe(true);
  expect(pages).toEqual([]);
});
