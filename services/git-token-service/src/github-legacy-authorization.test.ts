import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { verifyLegacyGitHubRepositoryId } from './github-legacy-authorization.js';

const fetchMock = vi.fn();
const verify = () => verifyLegacyGitHubRepositoryId('acme', 'repo', 101, 'synthetic-legacy-token');
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('legacy attachment repository identity', () => {
  it('requires the exact repository ID and case-insensitive full name', async () => {
    fetchMock.mockResolvedValue(Response.json({ id: 101, full_name: 'Acme/Repo' }));
    expect(await verify()).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://api.github.com/repos/acme/repo',
      expect.objectContaining({
        redirect: 'manual',
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({ Authorization: 'Bearer synthetic-legacy-token' }),
      })
    );
  });
  it.each([
    { id: 202, full_name: 'acme/repo' },
    { id: 101, full_name: 'acme/other' },
  ])('rejects authoritative identity mismatch %j', async value => {
    fetchMock.mockResolvedValue(Response.json(value));
    expect(await verify()).toBe('repository_mismatch');
  });
  it.each([302, 403, 404, 429, 503])(
    'fails closed on status %s without following redirects',
    async status => {
      fetchMock.mockResolvedValue(
        new Response('unavailable', { status, headers: { Location: 'https://example.com/other' } })
      );
      expect(await verify()).toBe('source_unavailable');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(fetchMock.mock.calls[0][1].redirect).toBe('manual');
    }
  );
  it('fails closed when response cancellation rejects', async () => {
    const response = new Response(
      new ReadableStream({
        cancel() {
          throw new Error('cancel failed');
        },
      }),
      { status: 503 }
    );
    fetchMock.mockResolvedValue(response);
    expect(await verify()).toBe('source_unavailable');
  });
  it('fails closed on a network failure', async () => {
    fetchMock.mockRejectedValue(new Error('unavailable'));
    expect(await verify()).toBe('source_unavailable');
  });
  it.each([
    () => new Response('not-json'),
    () => Response.json({ id: '101', full_name: 'acme/repo' }),
    () => Response.json({ id: 101 }),
    () => new Response(null),
    () => Response.json({ id: 101, full_name: 'acme/repo', padding: 'x'.repeat(64 * 1024) }),
  ])('fails closed on malformed, empty, or oversized metadata %#', async response => {
    fetchMock.mockResolvedValue(response());
    expect(await verify()).toBe('source_unavailable');
  });
});
