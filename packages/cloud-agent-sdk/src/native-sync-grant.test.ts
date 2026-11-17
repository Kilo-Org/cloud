import { NativeSyncClient } from './native-sync';

const grant = (token: string) => ({
  token,
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
});

test('provided grants are tenant cached and preferred over credentials', async () => {
  const getCredential = jest.fn(async () => 'private-credential');
  const getGrant = jest.fn(async () => grant('grant'));
  const fetcher = jest.fn(async () => Response.json({ ok: true }));
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential,
    getGrant,
    fetch: fetcher,
  });
  await client.request('/one', undefined, 'organization-a');
  await client.request('/two', undefined, 'organization-a');
  await client.request('/three');
  expect(getGrant.mock.calls).toEqual([['organization-a'], [undefined]]);
  expect(getCredential).not.toHaveBeenCalled();
  expect(fetcher.mock.calls).toHaveLength(3);
});

test('provided grant failure never falls back to credentials or exchange', async () => {
  const getCredential = jest.fn(async () => 'private-credential');
  const fetcher = jest.fn();
  const client = new NativeSyncClient({
    baseUrl: 'https://sync.test',
    getCredential,
    fetch: fetcher,
    getGrant: async () => {
      throw new Error('grant unavailable');
    },
  });
  await expect(client.request('/one')).rejects.toThrow('grant unavailable');
  expect(getCredential).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

test('a 401 renews a provided grant exactly once', async () => {
  const getGrant = jest
    .fn(async () => grant('first'))
    .mockResolvedValueOnce(grant('first'))
    .mockResolvedValue(grant('renewed'));
  const fetcher = jest.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
    Response.json({ error: { code: 'invalid_grant' } }, { status: 401 })
  );
  const client = new NativeSyncClient({ baseUrl: 'https://sync.test', getGrant, fetch: fetcher });
  await expect(client.request('/one')).rejects.toMatchObject({ status: 401 });
  expect(getGrant).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({
    headers: { Authorization: 'Bearer renewed' },
  });
});
