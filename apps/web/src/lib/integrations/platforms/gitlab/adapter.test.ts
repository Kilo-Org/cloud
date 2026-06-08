jest.mock('dns/promises', () => ({
  lookup: jest.fn(),
}));
jest.mock('https', () => ({
  request: jest.fn(),
}));

import { lookup } from 'dns/promises';
import { EventEmitter } from 'events';
import * as https from 'https';
import { PassThrough } from 'stream';
import {
  buildGitLabOAuthUrl,
  exchangeGitLabOAuthCode,
  refreshGitLabOAuthToken,
  validateGitLabInstance,
  validatePersonalAccessToken,
  createProjectWebhook,
  deleteProjectWebhook,
  searchGitLabProjects,
  normalizeGitLabSearchQuery,
  fetchGitLabRootTextFileAtRef,
} from './adapter';

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;
const mockLookup = lookup as jest.Mock;
const mockHttpsRequest = https.request as jest.Mock;

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  mockHttpsRequest.mockReset();
});

function mockSelfHostedGitLabResponse(args: {
  status: number;
  body?: string;
  json?: unknown;
  statusMessage?: string;
  headers?: Record<string, string>;
  responseError?: Error;
}) {
  mockHttpsRequest.mockImplementationOnce((_options, callback) => {
    const response = new PassThrough() as PassThrough & {
      statusCode?: number;
      statusMessage?: string;
      headers: Record<string, string>;
    };
    response.statusCode = args.status;
    response.statusMessage = args.statusMessage ?? 'OK';
    response.headers = { 'content-type': 'application/json', ...args.headers };

    const request = new EventEmitter() as EventEmitter & {
      write: jest.Mock;
      end: jest.Mock;
      destroy: jest.Mock;
      setTimeout: jest.Mock;
    };
    request.write = jest.fn();
    request.destroy = jest.fn();
    request.setTimeout = jest.fn();
    request.end = jest.fn(() => {
      callback?.(response as never);
      if (args.responseError) {
        response.emit('error', args.responseError);
        return;
      }
      response.end(args.body ?? JSON.stringify(args.json ?? {}));
    });

    return request as never;
  });
}

function mockSelfHostedGitLabError(error: Error) {
  mockHttpsRequest.mockImplementationOnce(() => {
    const request = new EventEmitter() as EventEmitter & {
      write: jest.Mock;
      end: jest.Mock;
      destroy: jest.Mock;
      setTimeout: jest.Mock;
    };
    request.write = jest.fn();
    request.destroy = jest.fn();
    request.setTimeout = jest.fn();
    request.end = jest.fn(() => {
      request.emit('error', error);
    });

    return request as never;
  });
}

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

describe('GitLab OAuth endpoint safety', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('refuses to build self-hosted authorization URLs without custom credentials', () => {
    expect(() => buildGitLabOAuthUrl('signed-state', 'https://attacker.example')).toThrow(
      'Custom GitLab OAuth credentials are required for self-hosted instances'
    );
  });

  it('refuses to send default OAuth credentials to self-hosted token endpoints', async () => {
    await expect(
      exchangeGitLabOAuthCode('authorization-code', 'https://attacker.example')
    ).rejects.toThrow('Custom GitLab OAuth credentials are required for self-hosted instances');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses to refresh self-hosted OAuth tokens without custom credentials', async () => {
    await expect(
      refreshGitLabOAuthToken('refresh-token', 'https://attacker.example')
    ).rejects.toThrow('Custom GitLab OAuth credentials are required for self-hosted instances');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('validateGitLabInstance', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('should return valid for a valid GitLab instance', async () => {
    mockSelfHostedGitLabResponse({
      status: 200,
      json: {
        version: '16.8.0',
        revision: 'abc123',
        kas: { enabled: true, externalUrl: null, version: null },
        enterprise: false,
      },
    });

    const result = await validateGitLabInstance('https://gitlab.example.com');

    expect(result.valid).toBe(true);
    expect(result.version).toBe('16.8.0');
    expect(result.revision).toBe('abc123');
    expect(result.enterprise).toBe(false);
    expect(result.error).toBeUndefined();
    expect(mockHttpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'gitlab.example.com',
        lookup: expect.any(Function),
        method: 'GET',
        headers: { accept: 'application/json' },
      }),
      expect.any(Function)
    );
  });

  it('should return valid for GitLab Enterprise Edition', async () => {
    mockSelfHostedGitLabResponse({
      status: 200,
      json: {
        version: '16.8.0-ee',
        revision: 'abc123',
        kas: { enabled: true, externalUrl: null, version: null },
        enterprise: true,
      },
    });

    const result = await validateGitLabInstance('https://gitlab.example.com');

    expect(result.valid).toBe(true);
    expect(result.version).toBe('16.8.0-ee');
    expect(result.enterprise).toBe(true);
  });

  it('should normalize URL by removing trailing slash', async () => {
    mockSelfHostedGitLabResponse({
      status: 200,
      json: {
        version: '16.8.0',
        revision: 'abc123',
        kas: { enabled: true, externalUrl: null, version: null },
        enterprise: false,
      },
    });

    await validateGitLabInstance('https://gitlab.example.com/');

    expect(mockHttpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({ path: '/api/v4/version' }),
      expect.any(Function)
    );
  });

  it('should return valid with warning when version endpoint requires auth (401)', async () => {
    mockSelfHostedGitLabResponse({ status: 401 });

    const result = await validateGitLabInstance('https://gitlab.example.com');

    expect(result.valid).toBe(true);
    expect(result.error).toContain('requires authentication');
  });

  it('should return valid with warning when version endpoint requires auth (403)', async () => {
    mockSelfHostedGitLabResponse({ status: 403 });

    const result = await validateGitLabInstance('https://gitlab.example.com');

    expect(result.valid).toBe(true);
    expect(result.error).toContain('requires authentication');
  });

  it('should return invalid for non-GitLab responses', async () => {
    mockSelfHostedGitLabResponse({
      status: 200,
      json: {
        name: 'Some other API',
      },
    });

    const result = await validateGitLabInstance('https://not-gitlab.example.com');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('does not appear to be from a GitLab instance');
  });

  it('should return invalid for 404 responses', async () => {
    mockSelfHostedGitLabResponse({ status: 404 });

    const result = await validateGitLabInstance('https://not-gitlab.example.com');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('returned status 404');
  });

  it('should follow self-hosted redirects after revalidating each destination', async () => {
    mockSelfHostedGitLabResponse({
      status: 302,
      headers: { location: 'https://gitlab.example.com/gitlab/api/v4/version' },
    });
    mockSelfHostedGitLabResponse({
      status: 200,
      json: {
        version: '16.8.0',
        revision: 'abc123',
        kas: { enabled: true, externalUrl: null, version: null },
        enterprise: false,
      },
    });

    const result = await validateGitLabInstance('https://gitlab.example.com');

    expect(result.valid).toBe(true);
    expect(mockHttpsRequest).toHaveBeenCalledTimes(2);
    expect(mockLookup).toHaveBeenCalledTimes(2);
  });

  it('should reject redirects to unsafe literal IP addresses before fetching them', async () => {
    mockSelfHostedGitLabResponse({
      status: 302,
      headers: { location: 'https://127.0.0.1/api/v4/version' },
    });

    const result = await validateGitLabInstance('https://gitlab.example.com');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('host is not allowed');
    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
    expect(mockFetch).not.toHaveBeenCalled();
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

  it('should return invalid for http instances before fetching', async () => {
    const result = await validateGitLabInstance('http://gitlab.example.com');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('must use https');
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return invalid for unsafe hosts before fetching', async () => {
    const result = await validateGitLabInstance('http://127.0.0.1:8080');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('host is not allowed');
    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return invalid when hostnames resolve to unsafe addresses before fetching', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);

    const result = await validateGitLabInstance('https://gitlab.example.com');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('resolves to an address that is not allowed');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should return invalid for URLs with credentials before fetching', async () => {
    const urlWithCredentials = new URL('https://gitlab.example.com');
    urlWithCredentials.username = 'user';
    urlWithCredentials.password = 'pass';

    const result = await validateGitLabInstance(urlWithCredentials.toString());

    expect(result.valid).toBe(false);
    expect(result.error).toContain('must not include credentials');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('should handle network errors gracefully', async () => {
    mockSelfHostedGitLabError(new TypeError('fetch failed'));

    const result = await validateGitLabInstance('https://unreachable.example.com');

    expect(result.valid).toBe(false);
    expect(result.error).toContain('Could not connect');
  });

  it('should handle timeout errors', async () => {
    const timeoutError = new Error('Timeout');
    timeoutError.name = 'TimeoutError';
    mockSelfHostedGitLabError(timeoutError);

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
    mockSelfHostedGitLabResponse({ status: 200, json: [] });

    await searchGitLabProjects('test-token', 'query', 'https://gitlab.example.com');

    expect(mockHttpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'gitlab.example.com',
        path: '/api/v4/projects?membership=true&search=query&per_page=20&archived=false',
      }),
      expect.any(Function)
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

describe('fetchGitLabRootTextFileAtRef', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('fetches root text file content from the requested ref', async () => {
    mockSelfHostedGitLabResponse({
      status: 200,
      body: '# Review policy\n\nFlag only regressions.',
    });

    const result = await fetchGitLabRootTextFileAtRef(
      'test-token',
      'group/subgroup/project',
      'REVIEW.md',
      'main',
      'https://gitlab.example.com/'
    );

    expect(result).toBe('# Review policy\n\nFlag only regressions.');
    expect(mockHttpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        hostname: 'gitlab.example.com',
        path: '/api/v4/projects/group%2Fsubgroup%2Fproject/repository/files/REVIEW.md/raw?ref=main',
        headers: {
          authorization: 'Bearer test-token',
        },
      }),
      expect.any(Function)
    );
  });

  it('returns null for 404 responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not found',
    });

    const result = await fetchGitLabRootTextFileAtRef(
      'test-token',
      'group/project',
      'REVIEW.md',
      'main'
    );

    expect(result).toBeNull();
  });

  it('returns empty text for empty file responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => '',
    });

    const result = await fetchGitLabRootTextFileAtRef(
      'test-token',
      'group/project',
      'REVIEW.md',
      'main'
    );

    expect(result).toBe('');
  });

  it('throws for non-404 failures', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => 'Server error',
    });

    await expect(
      fetchGitLabRootTextFileAtRef('test-token', 'group/project', 'REVIEW.md', 'main')
    ).rejects.toThrow('GitLab repository file fetch failed: 500');
  });
});

describe('deleteProjectWebhook', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('handles self-hosted 204 no-content responses', async () => {
    mockSelfHostedGitLabResponse({ status: 204, body: '' });

    await expect(
      deleteProjectWebhook('test-token', 123, 456, 'https://gitlab.example.com')
    ).resolves.toBeUndefined();

    expect(mockHttpsRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'DELETE',
        path: '/api/v4/projects/123/hooks/456',
      }),
      expect.any(Function)
    );
  });

  it('rejects self-hosted response stream errors', async () => {
    mockSelfHostedGitLabResponse({
      status: 200,
      responseError: new Error('response interrupted'),
    });

    await expect(
      deleteProjectWebhook('test-token', 123, 456, 'https://gitlab.example.com')
    ).rejects.toThrow('response interrupted');
  });

  it('rejects oversized self-hosted responses', async () => {
    mockSelfHostedGitLabResponse({ status: 200, body: 'x'.repeat(10 * 1024 * 1024 + 1) });

    await expect(
      deleteProjectWebhook('test-token', 123, 456, 'https://gitlab.example.com')
    ).rejects.toThrow('GitLab response exceeded size limit');
  });

  it('strips authorization headers when redirects change origin', async () => {
    mockSelfHostedGitLabResponse({
      status: 307,
      headers: { location: 'https://gitlab.example.com:8443/api/v4/projects/123/hooks/456' },
    });
    mockSelfHostedGitLabResponse({ status: 204, body: '' });

    await expect(
      deleteProjectWebhook('test-token', 123, 456, 'https://gitlab.example.com')
    ).resolves.toBeUndefined();

    expect(mockHttpsRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        headers: expect.not.objectContaining({ authorization: 'Bearer test-token' }),
        port: '8443',
      }),
      expect.any(Function)
    );
  });

  it('preserves DELETE methods across 302 redirects', async () => {
    mockSelfHostedGitLabResponse({
      status: 302,
      headers: { location: 'https://gitlab.example.com/api/v4/projects/123/hooks/456' },
    });
    mockSelfHostedGitLabResponse({ status: 204, body: '' });

    await expect(
      deleteProjectWebhook('test-token', 123, 456, 'https://gitlab.example.com')
    ).resolves.toBeUndefined();

    expect(mockHttpsRequest).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ method: 'DELETE' }),
      expect.any(Function)
    );
  });
});

describe('createProjectWebhook', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('rejects cross-origin 307 redirects before replaying request bodies', async () => {
    mockSelfHostedGitLabResponse({
      status: 307,
      headers: { location: 'https://redirect.example/api/v4/projects/123/hooks' },
    });

    await expect(
      createProjectWebhook(
        'test-token',
        123,
        'https://example.com/webhook',
        'webhook-secret',
        'https://gitlab.example.com'
      )
    ).rejects.toThrow('GitLab request refused cross-origin redirect with request body');

    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
  });
});

describe('validatePersonalAccessToken', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('rejects http instance URLs before fetching', async () => {
    const result = await validatePersonalAccessToken('pat-token', 'http://gitlab.example.com');

    expect(result).toEqual({
      valid: false,
      error: 'Invalid URL protocol. GitLab instance URLs must use https.',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects unsafe instance URLs before fetching', async () => {
    const result = await validatePersonalAccessToken('pat-token', 'http://169.254.169.254');

    expect(result).toEqual({
      valid: false,
      error: 'GitLab instance URL host is not allowed.',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects instance URLs that resolve to unsafe addresses before fetching', async () => {
    mockLookup.mockResolvedValueOnce([{ address: '10.0.0.1', family: 4 }]);

    const result = await validatePersonalAccessToken('pat-token', 'https://gitlab.example.com');

    expect(result).toEqual({
      valid: false,
      error: 'GitLab instance URL host resolves to an address that is not allowed.',
    });
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
