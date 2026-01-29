import { validateGitLabInstance } from './adapter';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('validateGitLabInstance', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should return valid for a valid GitLab instance', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        version: '16.8.0',
        revision: 'abc123',
        kas: { enabled: true, externalUrl: null, version: null },
        enterprise: false,
      }),
    });

    const result = await validateGitLabInstance('https://gitlab.example.com');

    expect(result.valid).toBe(true);
    expect(result.version).toBe('16.8.0');
    expect(result.revision).toBe('abc123');
    expect(result.enterprise).toBe(false);
    expect(result.error).toBeUndefined();
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.example.com/api/v4/version',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json' },
      })
    );
  });

  it('should return valid for GitLab Enterprise Edition', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        version: '16.8.0-ee',
        revision: 'abc123',
        kas: { enabled: true, externalUrl: null, version: null },
        enterprise: true,
      }),
    });

    const result = await validateGitLabInstance('https://gitlab.example.com');

    expect(result.valid).toBe(true);
    expect(result.version).toBe('16.8.0-ee');
    expect(result.enterprise).toBe(true);
  });

  it('should normalize URL by removing trailing slash', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        version: '16.8.0',
        revision: 'abc123',
        kas: { enabled: true, externalUrl: null, version: null },
        enterprise: false,
      }),
    });

    await validateGitLabInstance('https://gitlab.example.com/');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.example.com/api/v4/version',
      expect.anything()
    );
  });

  it('should return valid with warning when version endpoint requires auth (401)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
    });

    const result = await validateGitLabInstance('https://gitlab.example.com');

    expect(result.valid).toBe(true);
    expect(result.error).toContain('requires authentication');
  });

  it('should return valid with warning when version endpoint requires auth (403)', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
    });

    const result = await validateGitLabInstance('https://gitlab.example.com');

    expect(result.valid).toBe(true);
    expect(result.error).toContain('requires authentication');
  });

  it('should return invalid for non-GitLab responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        // Not a GitLab version response
        name: 'Some other API',
      }),
    });

    const result = await validateGitLabInstance('https://not-gitlab.example.com');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('does not appear to be from a GitLab instance');
  });

  it('should return invalid for 404 responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    const result = await validateGitLabInstance('https://not-gitlab.example.com');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('returned status 404');
  });

  it('should return invalid for invalid URL format', async () => {
    const result = await validateGitLabInstance('not-a-valid-url');

    expect(result.valid).toBe(false);
    expect(result.error).toBe('Invalid URL format.');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return invalid for non-http/https protocols', async () => {
    const result = await validateGitLabInstance('ftp://gitlab.example.com');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Invalid URL protocol');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should handle network errors gracefully', async () => {
    mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

    const result = await validateGitLabInstance('https://unreachable.example.com');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Could not connect');
  });

  it('should handle timeout errors', async () => {
    const timeoutError = new Error('Timeout');
    timeoutError.name = 'TimeoutError';
    mockFetch.mockRejectedValueOnce(timeoutError);

    const result = await validateGitLabInstance('https://slow.example.com');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('timed out');
  });
});
