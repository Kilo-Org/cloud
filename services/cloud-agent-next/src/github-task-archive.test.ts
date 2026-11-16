import { afterEach, describe, expect, it, vi } from 'vitest';
import { forwardGitHubTaskArchive } from './github-task-archive.js';

const repository = 'na2-org/cloud-agent-security-test-a';
const authorization = 'Bearer synthetic-upstream-token';
const api = (kind = 'zipball') => `https://api.github.com/repos/${repository}/${kind}/main`;
const storage = (format = 'legacy.zip') =>
  `https://codeload.github.com/${repository}/${format}/main?token=synthetic-download-secret`;
const redirect = (location = storage()) =>
  new Response('synthetic-redirect-secret', {
    status: 302,
    headers: { Location: location, 'Set-Cookie': 'synthetic-cookie' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('managed GitHub repository archives', () => {
  it('downloads a public archive without the managed credential', async () => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(new Response('archive'));
    vi.stubGlobal('fetch', upstream);
    await forwardGitHubTaskArchive(
      new Request(api(), { headers: { Authorization: 'Bearer synthetic-managed-alias' } }),
      null
    );
    const request = upstream.mock.calls[0][0] as Request;
    expect(request.headers.has('authorization')).toBe(false);
  });

  it.each([
    ['zipball', 'legacy.zip'],
    ['zipball', 'zip'],
    ['tarball', 'legacy.tar.gz'],
    ['tarball', 'tar.gz'],
  ])(
    'streams %s through a validated %s redirect without forwarding the backing credential',
    async (kind, format) => {
      const bytes = new Uint8Array([0, 1, 127, 255, 4]);
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(redirect(storage(format)))
        .mockResolvedValueOnce(
          new Response(bytes, {
            headers: {
              'Content-Type': 'application/octet-stream',
              'Content-Length': '5',
              'Content-Disposition': 'attachment; filename=fixture.zip',
              'Set-Cookie': 'synthetic-cookie',
              'X-Secret': 'synthetic-download-secret',
            },
          })
        );
      vi.stubGlobal('fetch', upstream);
      const response = await forwardGitHubTaskArchive(
        new Request(api(kind), {
          headers: { Accept: 'application/vnd.github+json', Authorization: 'Bearer guest-alias' },
        }),
        authorization
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('content-disposition')).toContain('fixture.zip');
      expect(response.headers.has('set-cookie')).toBe(false);
      expect(response.headers.has('location')).toBe(false);
      expect(response.headers.has('x-secret')).toBe(false);
      const first = upstream.mock.calls[0]?.[0] as Request;
      expect(first.url).toBe(api(kind));
      expect(first.headers.get('authorization')).toBe(authorization);
      expect(first.headers.get('accept-encoding')).toBe('identity');
      expect(first.redirect).toBe('manual');
      expect((upstream.mock.calls[1]?.[0] as URL | undefined)?.href).toBe(storage(format));
      const second = upstream.mock.calls[1]?.[1];
      expect(second?.method).toBe('GET');
      expect(second?.redirect).toBe('manual');
      expect(new Headers(second?.headers).has('authorization')).toBe(false);
      expect(new Headers(second?.headers).has('cookie')).toBe(false);
    }
  );

  it.each([
    storage().replace('test-a', 'test-b'),
    storage().replace('na2-org', 'other-org'),
    storage().replace('codeload.github.com', 'codeload.github.com.evil.test'),
    storage().replace('https:', 'http:'),
    storage().replace('codeload.github.com', 'codeload.github.com:8443'),
    storage().replace('codeload.github.com', 'user:password@codeload.github.com'),
    storage().replace('legacy.zip', 'legacy.tar.gz'),
    storage().replace('legacy.zip/main', 'releases/download/file.zip'),
    storage().replace('test-a', 'test-a-extra'),
    `${storage()}#fragment`,
    '/relative/location',
  ])('rejects unsafe archive redirect %s before the second request', async location => {
    const upstream = vi.fn<typeof fetch>().mockResolvedValue(redirect(location));
    vi.stubGlobal('fetch', upstream);
    await expect(forwardGitHubTaskArchive(new Request(api()), authorization)).rejects.toThrow(
      'Invalid GitHub archive redirect'
    );
    expect(upstream).toHaveBeenCalledOnce();
  });

  it('does not follow a second redirect or expose its location', async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(redirect('https://other.example/?secret=synthetic'));
    vi.stubGlobal('fetch', upstream);
    await expect(forwardGitHubTaskArchive(new Request(api()), authorization)).rejects.toThrow(
      'download unavailable'
    );
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it.each([401, 403, 404, 429, 500])(
    'retains upstream status %i without its body or credentials',
    async status => {
      const upstream = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response('synthetic-upstream-token', { status }));
      vi.stubGlobal('fetch', upstream);
      const response = await forwardGitHubTaskArchive(new Request(api()), authorization);
      expect(response.status).toBe(status);
      expect(await response.text()).toBe('GitHub archive unavailable');
      expect(upstream).toHaveBeenCalledOnce();
    }
  );

  it('preserves HEAD through the download hop', async () => {
    const upstream = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(redirect())
      .mockResolvedValueOnce(new Response(null, { headers: { 'Content-Length': '500' } }));
    vi.stubGlobal('fetch', upstream);
    const response = await forwardGitHubTaskArchive(
      new Request(api(), { method: 'HEAD' }),
      authorization
    );
    expect(response.body).toBeNull();
    expect(response.headers.get('content-length')).toBe('500');
    expect(upstream.mock.calls[1]?.[1]?.method).toBe('HEAD');
  });

  it('forwards direct archive responses without exposing cookies', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('synthetic-archive', { headers: { 'Set-Cookie': 'synthetic' } })
        )
    );
    const response = await forwardGitHubTaskArchive(new Request(api()), authorization);
    expect(await response.text()).toBe('synthetic-archive');
    expect(response.headers.has('set-cookie')).toBe(false);
  });
});
