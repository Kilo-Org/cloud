import {
  validateGitLabInstance,
  searchGitLabProjects,
  normalizeGitLabSearchQuery,
} from './adapter';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

describe('normalizeGitLabSearchQuery', () => {
  it('should extract project path from full GitLab URL', () => {
    const result = normalizeGitLabSearchQuery('https://gitlab.com/group123/project123');
    expect(result).toBe('group123/project123');
  });

  it('should extract project path from GitLab URL with trailing slash', () => {
    const result = normalizeGitLabSearchQuery('https://gitlab.com/group123/project123/');
    expect(result).toBe('group123/project123');
  });

  it('should extract project path from GitLab URL with subgroups', () => {
    const result = normalizeGitLabSearchQuery('https://gitlab.com/group/subgroup/project-name');
    expect(result).toBe('group/subgroup/project-name');
  });

  it('should extract project path from self-hosted GitLab URL', () => {
    const result = normalizeGitLabSearchQuery('https://gitlab.example.com/team/my-project');
    expect(result).toBe('team/my-project');
  });

  it('should strip /-/ suffixes from GitLab URLs (tree/branch)', () => {
    const result = normalizeGitLabSearchQuery('https://gitlab.com/group123/project123/-/tree/main');
    expect(result).toBe('group123/project123');
  });

  it('should strip /-/ suffixes from GitLab URLs (merge_requests)', () => {
    const result = normalizeGitLabSearchQuery(
      'https://gitlab.com/group123/project123/-/merge_requests'
    );
    expect(result).toBe('group123/project123');
  });

  it('should strip /-/ suffixes from GitLab URLs (issues)', () => {
    const result = normalizeGitLabSearchQuery(
      'https://gitlab.com/group123/project123/-/issues/123'
    );
    expect(result).toBe('group123/project123');
  });

  it('should return path format as-is', () => {
    const result = normalizeGitLabSearchQuery('group123/project123');
    expect(result).toBe('group123/project123');
  });

  it('should return project name only as-is', () => {
    const result = normalizeGitLabSearchQuery('project123');
    expect(result).toBe('project123');
  });

  it('should trim whitespace from query', () => {
    const result = normalizeGitLabSearchQuery('  project123  ');
    expect(result).toBe('project123');
  });

  it('should handle http URLs', () => {
    const result = normalizeGitLabSearchQuery('http://gitlab.local/team/project');
    expect(result).toBe('team/project');
  });

  it('should return invalid URL-like strings as-is', () => {
    // This doesn't start with http:// or https://, so it's treated as a search term
    const result = normalizeGitLabSearchQuery('gitlab.com/team/project');
    expect(result).toBe('gitlab.com/team/project');
  });
});

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

describe('searchGitLabProjects', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should search projects and return mapped results', async () => {
    const mockProjects = [
      {
        id: 123,
        name: 'my-project',
        path_with_namespace: 'group/my-project',
        visibility: 'private',
        default_branch: 'main',
        web_url: 'https://gitlab.com/group/my-project',
        archived: false,
      },
      {
        id: 456,
        name: 'another-project',
        path_with_namespace: 'group/another-project',
        visibility: 'public',
        default_branch: 'main',
        web_url: 'https://gitlab.com/group/another-project',
        archived: false,
      },
    ];

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockProjects,
    });

    const result = await searchGitLabProjects('test-token', 'my-project');

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      id: 123,
      name: 'my-project',
      full_name: 'group/my-project',
      private: true,
    });
    expect(result[1]).toEqual({
      id: 456,
      name: 'another-project',
      full_name: 'group/another-project',
      private: false,
    });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects?membership=true&search=my-project&per_page=20&archived=false',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer test-token',
        },
      })
    );
  });

  it('should use custom instance URL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await searchGitLabProjects('test-token', 'query', 'https://gitlab.example.com');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.example.com/api/v4/projects?membership=true&search=query&per_page=20&archived=false',
      expect.anything()
    );
  });

  it('should use custom limit', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await searchGitLabProjects('test-token', 'query', 'https://gitlab.com', 50);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects?membership=true&search=query&per_page=50&archived=false',
      expect.anything()
    );
  });

  it('should URL-encode the search query', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    // Use a query without / to test pure search encoding
    await searchGitLabProjects('test-token', 'my project name');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects?membership=true&search=my%20project%20name&per_page=20&archived=false',
      expect.anything()
    );
  });

  it('should throw error on API failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    await expect(searchGitLabProjects('invalid-token', 'query')).rejects.toThrow(
      'GitLab projects search failed: 401'
    );
  });

  it('should return empty array when no projects match', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const result = await searchGitLabProjects('test-token', 'nonexistent');

    expect(result).toEqual([]);
  });

  it('should try direct path lookup first when query contains /', async () => {
    const mockProject = {
      id: 123,
      name: 'project123',
      path_with_namespace: 'group123/project123',
      visibility: 'private',
      default_branch: 'main',
      web_url: 'https://gitlab.com/group123/project123',
      archived: false,
    };

    // First call: direct path lookup succeeds
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockProject,
    });

    const result = await searchGitLabProjects(
      'test-token',
      'https://gitlab.com/group123/project123'
    );

    // Should return the directly fetched project
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 123,
      name: 'project123',
      full_name: 'group123/project123',
      private: true,
    });

    // Should have called the direct project endpoint
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/group123%2Fproject123',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer test-token',
        },
      })
    );

    // Should NOT have called the search endpoint
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('should fall back to search when direct path lookup returns 404', async () => {
    // First call: direct path lookup fails with 404
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
    });

    // Second call: search returns results
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await searchGitLabProjects('test-token', 'group123/project123');

    // Should have called both endpoints
    expect(mockFetch).toHaveBeenCalledTimes(2);

    // First call: direct lookup
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://gitlab.com/api/v4/projects/group123%2Fproject123',
      expect.anything()
    );

    // Second call: search fallback
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://gitlab.com/api/v4/projects?membership=true&search=group123%2Fproject123&per_page=20&archived=false',
      expect.anything()
    );
  });

  it('should skip archived projects in direct path lookup', async () => {
    const mockArchivedProject = {
      id: 123,
      name: 'project123',
      path_with_namespace: 'group123/project123',
      visibility: 'private',
      default_branch: 'main',
      web_url: 'https://gitlab.com/group123/project123',
      archived: true, // Project is archived
    };

    // First call: direct path lookup returns archived project
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockArchivedProject,
    });

    // Second call: search fallback
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    const result = await searchGitLabProjects('test-token', 'group123/project123');

    // Should fall back to search and return empty
    expect(result).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should normalize GitLab URL with /-/ suffix and do direct lookup', async () => {
    const mockProject = {
      id: 123,
      name: 'project123',
      path_with_namespace: 'group123/project123',
      visibility: 'public',
      default_branch: 'main',
      web_url: 'https://gitlab.com/group123/project123',
      archived: false,
    };

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => mockProject,
    });

    const result = await searchGitLabProjects(
      'test-token',
      'https://gitlab.com/group123/project123/-/merge_requests'
    );

    // Should return the project from direct lookup
    expect(result).toHaveLength(1);
    expect(result[0].full_name).toBe('group123/project123');

    // Should have called direct lookup with cleaned path (no /-/merge_requests)
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/group123%2Fproject123',
      expect.anything()
    );
  });

  it('should not do direct lookup for simple project names without /', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [],
    });

    await searchGitLabProjects('test-token', 'project123');

    // Should only call search, not direct lookup
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects?membership=true&search=project123&per_page=20&archived=false',
      expect.anything()
    );
  });
});
