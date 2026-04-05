import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setAppSecret, deleteAppSecret, listAppSecrets } from './secrets';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

const config = { apiToken: 'test-token', appName: 'test-app' };

beforeEach(() => {
  vi.clearAllMocks();
});

describe('setAppSecret', () => {
  it('calls POST /secrets/{name} with value and returns version', async () => {
    mockFetch.mockResolvedValue(
      new Response(JSON.stringify({ name: 'MY_SECRET', version: 3 }), { status: 201 })
    );

    const result = await setAppSecret(config, 'MY_SECRET', 'secret-value');

    expect(result.version).toBe(3);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.machines.dev/v1/apps/test-app/secrets/MY_SECRET',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ value: 'secret-value' }),
      })
    );
  });

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(new Response('{"error":"bad"}', { status: 400 }));

    await expect(setAppSecret(config, 'BAD', 'val')).rejects.toThrow('setAppSecret failed');
  });
});

describe('deleteAppSecret', () => {
  it('calls DELETE /secrets/{name}', async () => {
    mockFetch.mockResolvedValue(new Response('{}', { status: 200 }));

    await deleteAppSecret(config, 'MY_SECRET');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.machines.dev/v1/apps/test-app/secrets/MY_SECRET',
      expect.objectContaining({ method: 'DELETE' })
    );
  });

  it('treats 404 as success (already gone)', async () => {
    mockFetch.mockResolvedValue(new Response('', { status: 404 }));
    await expect(deleteAppSecret(config, 'GONE')).resolves.toBeUndefined();
  });
});

describe('listAppSecrets', () => {
  it('returns secret names and digests', async () => {
    mockFetch.mockResolvedValue(
      new Response(
        JSON.stringify({
          secrets: [
            { name: 'KEY_A', digest: 'abc123' },
            { name: 'KEY_B', digest: 'def456' },
          ],
        }),
        { status: 200 }
      )
    );

    const secrets = await listAppSecrets(config);
    expect(secrets).toEqual([
      { name: 'KEY_A', digest: 'abc123' },
      { name: 'KEY_B', digest: 'def456' },
    ]);
  });
});
