jest.mock('@/lib/config.server', () => ({
  GIT_TOKEN_SERVICE_API_URL: 'https://token-service.example',
}));
jest.mock('@/lib/tokens', () => ({
  BITBUCKET_REPOSITORY_LIST_AUDIENCE: 'bitbucket-repository-list',
  TOKEN_EXPIRY: { fiveMinutes: 300 },
  generateInternalServiceToken: () => 'service-token',
}));

import {
  BitbucketRepositoryListResultSchema,
  fetchBitbucketRepositoriesFromTokenService,
  fetchBitbucketWorkspaceAccessTokenRepositoriesFromTokenService,
} from './token-service-client';

const fetchMock = jest.spyOn(globalThis, 'fetch');
const repository = {
  id: '12345678-1234-4234-8234-123456789012',
  workspaceUuid: '12345678-1234-4234-8234-123456789013',
  name: 'repo',
  fullName: 'workspace/repo',
  private: true,
  defaultBranch: 'main',
};
afterAll(() => fetchMock.mockRestore());
afterEach(() => jest.useRealTimers());

it.each([
  fetchBitbucketRepositoriesFromTokenService,
  fetchBitbucketWorkspaceAccessTokenRepositoriesFromTokenService,
])('bounds both authentication paths without changing legacy results', async read => {
  fetchMock.mockImplementation(async (_url, init) => {
    if (new Headers(init?.headers).get('authorization') !== 'Bearer service-token')
      throw new Error('Missing authentication');
    return Response.json({ status: 'available', repositories: Array(51).fill(repository) });
  });
  await expect(read('user', 'organization', { bounded: true })).resolves.toEqual({
    status: 'available',
    repositories: Array(50).fill(repository),
  });
  await expect(read('user', 'organization')).resolves.toEqual({
    status: 'available',
    repositories: Array(51).fill(repository),
  });
});

it.each([
  { status: 'available', repositories: [] },
  { status: 'reconnect_required' },
  { status: 'temporarily_unavailable' },
])('preserves explicit provider states %j', async data => {
  fetchMock.mockResolvedValue(Response.json(data));
  await expect(
    fetchBitbucketRepositoriesFromTokenService('user', undefined, { bounded: true })
  ).resolves.toEqual(data);
});

it.each([
  { status: 'available', repositories: [...Array(50).fill(repository), null] },
  'invalid json',
])(
  'rejects malformed or oversized bounded data %# but preserves the legacy fallback',
  async data => {
    fetchMock.mockImplementation(async () =>
      typeof data === 'string'
        ? new Response(data, { headers: { 'content-type': 'application/json' } })
        : Response.json(data)
    );
    await expect(
      fetchBitbucketRepositoriesFromTokenService('user', undefined, { bounded: true })
    ).rejects.toThrow();
    await expect(fetchBitbucketRepositoriesFromTokenService('user')).resolves.toEqual({
      status: 'temporarily_unavailable',
    });
  }
);

it('rejects valid oversized JSON but keeps the legacy response unchanged', async () => {
  const data = {
    status: 'available',
    repositories: [{ ...repository, name: 'x'.repeat(1048577) }],
  };
  fetchMock.mockImplementation(async () => Response.json(data));
  await expect(
    fetchBitbucketRepositoriesFromTokenService('user', undefined, { bounded: true })
  ).rejects.toThrow('size limit');
  await expect(fetchBitbucketRepositoriesFromTokenService('user')).resolves.toEqual(data);
});

it('keeps network failures retryable without treating them as empty data', async () => {
  fetchMock.mockRejectedValue(new Error('network unavailable'));
  await expect(fetchBitbucketRepositoriesFromTokenService('user')).resolves.toEqual({
    status: 'temporarily_unavailable',
  });
  await expect(
    fetchBitbucketRepositoriesFromTokenService('user', undefined, { bounded: true })
  ).rejects.toThrow('network unavailable');
  fetchMock.mockResolvedValue(Response.json({ status: 'available', repositories: [] }));
  await expect(
    fetchBitbucketRepositoriesFromTokenService('user', undefined, { bounded: true })
  ).resolves.toEqual({ status: 'available', repositories: [] });
});

it('cancels token-service response consumption at the deadline', async () => {
  jest.useFakeTimers();
  let cancelled = false;
  fetchMock.mockResolvedValue(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      { headers: { 'content-type': 'application/json' } }
    )
  );
  const result = fetchBitbucketRepositoriesFromTokenService('user', undefined, { bounded: true });
  const rejection = expect(result).rejects.toThrow('Repository fetch timed out');
  await jest.advanceTimersByTimeAsync(30_000);
  await rejection;
  expect(cancelled).toBe(true);
});

describe('BitbucketRepositoryListResultSchema', () => {
  it.each(['insufficient_permissions', 'invalid_request'] as const)(
    'accepts the static token-service %s result',
    status => {
      expect(BitbucketRepositoryListResultSchema.parse({ status })).toEqual({ status });
    }
  );
});
