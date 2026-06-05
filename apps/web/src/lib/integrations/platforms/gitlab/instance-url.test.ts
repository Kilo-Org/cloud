jest.mock('dns/promises', () => ({
  lookup: jest.fn(),
}));

import { lookup } from 'dns/promises';
import {
  assertGitLabUrlResolvesSafely,
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

  it('does not resolve the default GitLab host', async () => {
    await expect(
      assertGitLabUrlResolvesSafely('https://gitlab.com/api/v4/user')
    ).resolves.toBeUndefined();

    expect(mockLookup).not.toHaveBeenCalled();
  });
});
