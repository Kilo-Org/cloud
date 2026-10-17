jest.mock('dns/promises', () => ({
  lookup: jest.fn(),
}));

import { lookup } from 'dns/promises';
import {
  assertGitLabUrlResolvesSafely,
  buildGitLabPlatformRepositoryId,
  buildGitLabUrl,
  isDefaultGitLabInstanceUrl,
  normalizeGitLabInstanceUrl,
} from './instance-url';

const mockLookup = lookup as jest.Mock;

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
});

describe('GitLab instance URL safety', () => {
  it('defaults to gitlab.com', () => {
    expect(normalizeGitLabInstanceUrl(undefined)).toBe('https://gitlab.com');
    expect(normalizeGitLabInstanceUrl('')).toBe('https://gitlab.com');
    expect(isDefaultGitLabInstanceUrl('https://gitlab.com/')).toBe(true);
  });

  it('canonicalizes hosts and preserves self-hosted base paths', () => {
    expect(normalizeGitLabInstanceUrl('https://GitLab.Example.COM/gitlab/')).toBe(
      'https://gitlab.example.com/gitlab'
    );
    expect(buildGitLabUrl('https://GitLab.Example.COM/gitlab/', '/api/v4/user')).toBe(
      'https://gitlab.example.com/gitlab/api/v4/user'
    );
  });

  it('builds instance-qualified platform repository IDs', () => {
    expect(buildGitLabPlatformRepositoryId({ instanceUrl: undefined, projectId: 123 })).toBe(
      'https://gitlab.com/-/projects/123'
    );
    expect(
      buildGitLabPlatformRepositoryId({
        instanceUrl: 'https://GitLab.Example.COM/gitlab/',
        projectId: 456,
      })
    ).toBe('https://gitlab.example.com/gitlab/-/projects/456');
  });

  const urlWithCredentials = new URL('https://gitlab.example.com');
  urlWithCredentials.username = 'user';
  urlWithCredentials.password = 'pass';

  it.each([
    ['ftp://gitlab.example.com', 'Invalid URL protocol'],
    ['http://gitlab.example.com', 'must use https'],
    [urlWithCredentials.toString(), 'must not include credentials'],
    ['https://gitlab.example.com?next=/api', 'must not include query strings'],
    ['https://gitlab.example.com#fragment', 'must not include query strings'],
    ['http://localhost:8080', 'host is not allowed'],
    ['http://127.0.0.1:8080', 'host is not allowed'],
    ['http://[::1]:8080', 'host is not allowed'],
    ['http://[fec0::1]:8080', 'host is not allowed'],
    ['http://169.254.169.254/latest/meta-data', 'host is not allowed'],
    ['http://10.0.0.1', 'host is not allowed'],
    ['http://172.16.0.1', 'host is not allowed'],
    ['http://192.168.0.1', 'host is not allowed'],
    ['https://gitlab.local', 'host is not allowed'],
  ])('rejects unsafe instance URL %p', (url, message) => {
    expect(() => normalizeGitLabInstanceUrl(url)).toThrow(message);
  });

  it('accepts hostnames that resolve to public addresses', async () => {
    await expect(
      assertGitLabUrlResolvesSafely('https://gitlab.example.com/api/v4/user')
    ).resolves.toBeUndefined();

    expect(mockLookup).toHaveBeenCalledWith('gitlab.example.com', {
      all: true,
      verbatim: true,
    });
  });

  it('rejects hostnames that resolve to unsafe addresses', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '192.168.1.10', family: 4 }]);

    await expect(
      assertGitLabUrlResolvesSafely('https://gitlab.example.com/api/v4/user')
    ).rejects.toThrow('resolves to an address that is not allowed');
  });

  it('rejects hostnames that resolve to deprecated IPv6 site-local addresses', async () => {
    mockLookup.mockResolvedValueOnce([{ address: 'fec0::1', family: 6 }]);

    await expect(
      assertGitLabUrlResolvesSafely('https://gitlab.example.com/api/v4/user')
    ).rejects.toThrow('resolves to an address that is not allowed');
  });

  it('rejects unsafe literal IP URLs during fetch-time validation', async () => {
    await expect(assertGitLabUrlResolvesSafely('http://127.0.0.1/api/v4/user')).rejects.toThrow(
      'host is not allowed'
    );

    expect(mockLookup).not.toHaveBeenCalled();
  });

  it.each([
    ['https://[::7f00:1]', 'IPv4-compatible loopback'],
    ['https://[64:ff9b::a9fe:a9fe]', 'NAT64 metadata'],
    ['https://[64:ff9b:1::1]', 'local NAT64'],
    ['https://[2002:7f00:1::]', '6to4 loopback'],
    ['https://[::ffff:127.0.0.1]', 'IPv4-mapped loopback dotted'],
    ['https://[::ffff:7f00:1]', 'IPv4-mapped loopback hex'],
    ['https://[::ffff:0:127.0.0.1]', 'IPv4-translated loopback dotted'],
    ['https://[::ffff:0:7f00:1]', 'IPv4-translated loopback hex'],
    ['https://[100::1]', 'discard-only'],
    ['https://[3fff::1]', 'documentation 3fff'],
    ['https://[2001:db8::1]', 'documentation 2001:db8'],
    ['https://[fc00::1]', 'unique local'],
    ['https://[fe80::1]', 'link local'],
    ['https://[fec0::1]', 'deprecated site local'],
    ['https://[fee0::1]', 'site local upper half'],
    ['https://[ff02::1]', 'multicast'],
  ])('rejects embedded-IPv4 and special-purpose IPv6 literal %p (%s)', async url => {
    await expect(assertGitLabUrlResolvesSafely(url)).rejects.toThrow('not allowed');
    expect(() => normalizeGitLabInstanceUrl(url)).toThrow('host is not allowed');
  });

  it.each([
    ['https://[2606:4700::6810:85e5]', 'ordinary public IPv6'],
    ['https://[::ffff:8.8.8.8]', 'IPv4-mapped public dotted'],
    ['https://[::ffff:808:808]', 'IPv4-mapped public hex'],
    ['https://[::ffff:0:808:808]', 'IPv4-translated public hex'],
    ['https://[2002:808:808::]', '6to4 public'],
  ])('accepts safe public IPv6 literal %p (%s)', async url => {
    await expect(assertGitLabUrlResolvesSafely(url)).resolves.toBeUndefined();
  });

  it('does not resolve the default GitLab host', async () => {
    await expect(
      assertGitLabUrlResolvesSafely('https://gitlab.com/api/v4/user')
    ).resolves.toBeUndefined();

    expect(mockLookup).not.toHaveBeenCalled();
  });
});
