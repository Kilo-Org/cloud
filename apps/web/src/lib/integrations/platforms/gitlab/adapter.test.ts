jest.mock('dns/promises', () => ({
  lookup: jest.fn(),
}));
jest.mock('https', () => ({
  request: jest.fn(),
}));
const mockLogExceptInTest = jest.fn();
jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  logExceptInTest: (...args: unknown[]) => mockLogExceptInTest(...args),
}));

import { lookup } from 'dns/promises';
import { EventEmitter } from 'events';
import * as https from 'https';
import { PassThrough } from 'stream';
import {
  buildGitLabOAuthUrl,
  exchangeGitLabOAuthCode,
  validateGitLabInstance,
  validatePersonalAccessToken,
  createProjectWebhook,
  createMRNote,
  createProjectAccessToken,
  deleteProjectWebhook,
  fetchGitLabProjects,
  fetchGitLabBranches,
  fetchGitLabRootTextFileAtRef,
  fetchGitLabRepositorySize,
  GitLabAuthenticationError,
  GitLabProjectAccessTokenPermissionError,
  GitLabWebhookPermissionError,
  getMRDiffRefs,
  getMRHeadCommit,
  listProjectAccessTokens,
  listProjectWebhooks,
  revokeProjectAccessToken,
  rotateProjectAccessToken,
  updateProjectWebhook,
  fetchMRInlineComments,
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

function createGitLabProjectDiscoveryResponse() {
  return [
    {
      id: 123,
      name: 'active-project',
      path_with_namespace: 'group/active-project',
      visibility: 'private',
      default_branch: 'main',
      web_url: 'https://gitlab.com/group/active-project',
      archived: false,
    },
    {
      id: 456,
      name: 'archived-project',
      path_with_namespace: 'group/archived-project',
      visibility: 'private',
      default_branch: 'main',
      web_url: 'https://gitlab.com/group/archived-project',
      archived: true,
    },
    {
      id: 789,
      name: 'scheduled-project',
      path_with_namespace: 'group/scheduled-project',
      visibility: 'private',
      default_branch: 'main',
      web_url: 'https://gitlab.com/group/scheduled-project',
      archived: false,
      marked_for_deletion_on: '2026-07-01',
    },
    {
      id: 101,
      name: 'legacy-scheduled-project',
      path_with_namespace: 'group/legacy-scheduled-project',
      visibility: 'private',
      default_branch: 'main',
      web_url: 'https://gitlab.com/group/legacy-scheduled-project',
      archived: false,
      marked_for_deletion_at: '2026-07-01',
    },
  ];
}

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
    const result = await validateGitLabInstance('https://127.0.0.1:8080');

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

describe('fetchGitLabProjects', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('returns active projects across every page', async () => {
    const projects = createGitLabProjectDiscoveryResponse();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => projects.slice(1),
        headers: {
          get: (name: string) => (name === 'x-next-page' ? '2' : null),
        },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => projects.slice(0, 1),
        headers: {
          get: () => null,
        },
      });

    const result = await fetchGitLabProjects('test-token');

    expect(result).toEqual([
      {
        id: 123,
        name: 'active-project',
        full_name: 'group/active-project',
        private: true,
      },
    ]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(
      1,
      'https://gitlab.com/api/v4/projects?membership=true&per_page=100&page=1&archived=false',
      expect.anything()
    );
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://gitlab.com/api/v4/projects?membership=true&per_page=100&page=2&archived=false',
      expect.anything()
    );
  });

  it('treats a missing x-next-page on a full page as the last page', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `project-${i}`,
      path_with_namespace: `group/project-${i}`,
      visibility: 'private',
      archived: false,
    }));
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => fullPage,
        headers: { get: () => null },
      })
    );

    const projects = await fetchGitLabProjects('test-token');
    expect(projects).toHaveLength(100);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reports an error when x-next-page advances beyond the page cap', async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => ({
      id: i + 1,
      name: `project-${i}`,
      path_with_namespace: `group/project-${i}`,
      visibility: 'private',
      archived: false,
    }));
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => fullPage,
        headers: { get: (name: string) => (name === 'x-next-page' ? '999999' : null) },
      })
    );

    await expect(fetchGitLabProjects('test-token')).rejects.toThrow(
      'GitLab pagination limit exceeded: project listing returned more than 100 pages'
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reports an error when a single page returns more than the item cap', async () => {
    const hugePage = Array.from({ length: 10001 }, (_, i) => ({
      id: i + 1,
      name: `project-${i}`,
      path_with_namespace: `group/project-${i}`,
      visibility: 'private',
      archived: false,
    }));
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => hugePage,
        headers: { get: () => null },
      })
    );

    await expect(fetchGitLabProjects('test-token')).rejects.toThrow(
      'GitLab pagination limit exceeded: project listing returned more than 10000 items'
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('reports an error when a provider signals a huge x-total-pages with full pages', async () => {
    const branches = Array.from({ length: 100 }, (_, i) => ({
      name: `branch-${i}`,
      commit: { id: 'abc' },
    }));
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => branches,
        headers: { get: (name: string) => (name === 'x-total-pages' ? '999999' : null) },
      })
    );

    await expect(fetchGitLabBranches('test-token', 123)).rejects.toThrow(
      'GitLab pagination limit exceeded: branch listing returned more than 100 pages'
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('treats a non-numeric x-total-pages as a single page', async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        json: async () => [{ name: 'main', commit: { id: 'abc' } }],
        headers: { get: (name: string) => (name === 'x-total-pages' ? 'not-a-number' : null) },
      })
    );

    const branches = await fetchGitLabBranches('test-token', 123);
    expect(branches.map(b => b.name)).toEqual(['main']);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('terminates normally when a provider reports a finite x-total-pages', async () => {
    let call = 0;
    mockFetch.mockImplementation(() => {
      call++;
      return Promise.resolve({
        ok: true,
        json: async () => [{ name: call === 1 ? 'main' : 'feature', commit: { id: 'abc' } }],
        headers: { get: (name: string) => (name === 'x-total-pages' ? '2' : null) },
      });
    });

    const branches = await fetchGitLabBranches('test-token', 123);
    expect(branches.map(b => b.name)).toEqual(['main', 'feature']);
    expect(mockFetch).toHaveBeenCalledTimes(2);
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

describe('fetchGitLabRepositorySize', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('fetches project statistics and formats repository_size bytes as MiB', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ statistics: { repository_size: 104_857_600 } }),
    });

    const result = await fetchGitLabRepositorySize('test-token', 'group/project');

    expect(result).toBe('100 MiB');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/group%2Fproject?statistics=true',
      expect.objectContaining({
        headers: {
          Authorization: 'Bearer test-token',
        },
      })
    );
  });

  it('formats zero-sized repositories explicitly', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ statistics: { repository_size: 0 } }),
    });

    await expect(fetchGitLabRepositorySize('test-token', 'group/project')).resolves.toBe('0 MiB');
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

  it('configures the same events when creating and when updating a webhook', async () => {
    mockSelfHostedGitLabResponse({ status: 201, json: { id: 7 } });
    await createProjectWebhook(
      'test-token',
      123,
      'https://example.com/webhook',
      'webhook-secret',
      'https://gitlab.example.com'
    );

    mockSelfHostedGitLabResponse({ status: 200, json: { id: 7 } });
    await updateProjectWebhook(
      'test-token',
      123,
      7,
      'https://example.com/webhook',
      'webhook-secret',
      'https://gitlab.example.com'
    );

    const [createOptions, updateOptions] = mockHttpsRequest.mock.calls.map(call => call[0]);
    const [createBody, updateBody] = mockHttpsRequest.mock.results.map(result =>
      String(result.value.write.mock.calls[0][0])
    );

    expect(createOptions).toMatchObject({ method: 'POST', path: '/api/v4/projects/123/hooks' });
    expect(updateOptions).toMatchObject({ method: 'PUT', path: '/api/v4/projects/123/hooks/7' });
    expect(createBody).toBe(updateBody);
    expect(JSON.parse(createBody)).toEqual({
      name: 'Kilo Code Reviews',
      description: 'Auto-configured webhook for Kilo AI code reviews',
      url: 'https://example.com/webhook',
      token: 'webhook-secret',
      merge_requests_events: true,
      push_events: false,
      issues_events: false,
      confidential_issues_events: false,
      tag_push_events: false,
      note_events: false,
      confidential_note_events: false,
      job_events: false,
      pipeline_events: false,
      wiki_page_events: false,
      deployment_events: false,
      releases_events: false,
      enable_ssl_verification: true,
    });
  });
});

describe('merge request reads', () => {
  const mergeRequest = {
    sha: 'abc123def456',
    diff_refs: { base_sha: 'base00000000', head_sha: 'head00000000', start_sha: 'start000000' },
  };

  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('reads the head commit from one merge request fetch', async () => {
    mockSelfHostedGitLabResponse({ status: 200, json: mergeRequest });

    await expect(getMRHeadCommit('test-token', 123, 9, 'https://gitlab.example.com')).resolves.toBe(
      'abc123def456'
    );

    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
    expect(mockHttpsRequest.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      path: '/api/v4/projects/123/merge_requests/9',
    });
  });

  it('reads the diff refs from one merge request fetch', async () => {
    mockSelfHostedGitLabResponse({ status: 200, json: mergeRequest });

    await expect(
      getMRDiffRefs('test-token', 'group/project', 9, 'https://gitlab.example.com')
    ).resolves.toEqual({
      baseSha: 'base00000000',
      headSha: 'head00000000',
      startSha: 'start000000',
    });

    expect(mockHttpsRequest).toHaveBeenCalledTimes(1);
    expect(mockHttpsRequest.mock.calls[0][0]).toMatchObject({
      method: 'GET',
      path: '/api/v4/projects/group%2Fproject/merge_requests/9',
    });
  });

  it.each([
    undefined,
    null,
    { ...mergeRequest.diff_refs, base_sha: undefined },
    { ...mergeRequest.diff_refs, head_sha: null },
    { ...mergeRequest.diff_refs, start_sha: '' },
  ])('rejects unavailable diff positions (%j)', async diffRefs => {
    mockSelfHostedGitLabResponse({
      status: 200,
      json: { ...mergeRequest, diff_refs: diffRefs },
    });

    await expect(
      getMRDiffRefs('test-token', 'group/project', 9, 'https://gitlab.example.com')
    ).rejects.toThrow('GitLab merge request has no diff refs');
  });

  it('reports a failed merge request fetch with its status', async () => {
    mockSelfHostedGitLabResponse({ status: 500, body: 'boom' });

    await expect(getMRDiffRefs('test-token', 123, 9, 'https://gitlab.example.com')).rejects.toThrow(
      'GitLab MR fetch failed: 500'
    );
  });
});

describe('revokeProjectAccessToken', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('treats a 404 response as already revoked', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: async () => 'Not found',
    });

    await expect(revokeProjectAccessToken('user-token', 42, 601)).resolves.toBeUndefined();

    expect(mockFetch).toHaveBeenCalledWith(
      'https://gitlab.com/api/v4/projects/42/access_tokens/601',
      expect.objectContaining({
        method: 'DELETE',
        headers: { Authorization: 'Bearer user-token' },
      })
    );
  });

  it('reports the response status when the revocation is not settled', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      text: async () => 'Service Unavailable',
    });

    await expect(revokeProjectAccessToken('user-token', 42, 601)).rejects.toMatchObject({
      name: 'GitLabProjectAccessTokenRevocationError',
      projectId: 42,
      status: 503,
      message: 'GitLab revoke Project Access Token failed: 503',
    });
  });

  it('reports a permission failure for a 403 response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });

    await expect(revokeProjectAccessToken('user-token', 42, 601)).rejects.toMatchObject({
      name: 'GitLabProjectAccessTokenPermissionError',
      statusCode: 403,
    });
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
    const result = await validatePersonalAccessToken('pat-token', 'https://169.254.169.254');

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

  it('applies the response size cap to a literal-IP instance using the fallback fetch', async () => {
    const oversizedBody = 'a'.repeat(10 * 1024 * 1024 + 1);
    mockFetch.mockResolvedValueOnce(
      new Response(oversizedBody, {
        status: 200,
        headers: { 'content-length': String(oversizedBody.length) },
      })
    );

    await expect(
      fetchGitLabRootTextFileAtRef(
        'test-token',
        'group/project',
        'REVIEW.md',
        'main',
        'https://[2002:808:808::]/'
      )
    ).rejects.toThrow('GitLab response exceeded size limit');

    expect(mockFetch).toHaveBeenCalledWith(
      'https://[2002:808:808::]/api/v4/projects/group%2Fproject/repository/files/REVIEW.md/raw?ref=main',
      expect.objectContaining({ redirect: 'manual' })
    );
  });

  it('applies the streamed size cap to a literal-IP instance without content-length', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(1024 * 1024).fill(97);
        for (let i = 0; i < 11; i++) {
          controller.enqueue(chunk);
        }
        controller.close();
      },
    });
    mockFetch.mockResolvedValueOnce(new Response(stream, { status: 200 }));

    await expect(
      fetchGitLabRootTextFileAtRef(
        'test-token',
        'group/project',
        'REVIEW.md',
        'main',
        'https://[2002:808:808::]/'
      )
    ).rejects.toThrow('GitLab response exceeded size limit');
  });

  it('defaults the fallback fetch deadline when the caller passes no signal', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => 'ok',
    });

    const result = await fetchGitLabRootTextFileAtRef(
      'test-token',
      'group/project',
      'REVIEW.md',
      'main',
      'https://[2002:808:808::]/'
    );

    expect(result).toBe('ok');
    const init = mockFetch.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect((init.signal as AbortSignal).aborted).toBe(false);
  });
});

describe('provider failure content', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockLogExceptInTest.mockReset();
  });

  function mockFailureResponse(status: number, body: string) {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status,
      text: async () => body,
    });
  }

  it('writes one log line with the operation, status, and a capped message', async () => {
    mockFailureResponse(500, 'message: branch is protected\n  details: second line');

    await expect(
      createProjectWebhook('test-token', 123, 'https://example.com/webhook', 'webhook-secret')
    ).rejects.toThrow(/^GitLab create webhook failed: 500$/);

    expect(mockLogExceptInTest).toHaveBeenCalledWith('GitLab create webhook failed:', {
      status: 500,
      bodyExcerpt: 'message: branch is protected details: second line',
      projectId: 123,
    });
  });

  it('truncates a long provider message in the log line', async () => {
    const providerBody = `message: ${'x'.repeat(400)}`;
    mockFailureResponse(500, providerBody);

    await expect(
      createProjectWebhook('test-token', 123, 'https://example.com/webhook', 'webhook-secret')
    ).rejects.toThrow(/^GitLab create webhook failed: 500$/);

    expect(mockLogExceptInTest).toHaveBeenCalledWith('GitLab create webhook failed:', {
      status: 500,
      bodyExcerpt: `${providerBody.slice(0, 199)}…`,
      projectId: 123,
    });
  });

  it('keeps a provider message at the excerpt limit unchanged', async () => {
    const providerBody = 'x'.repeat(200);
    mockFailureResponse(500, providerBody);

    await expect(
      createProjectWebhook('test-token', 123, 'https://example.com/webhook', 'webhook-secret')
    ).rejects.toThrow(/^GitLab create webhook failed: 500$/);

    expect(mockLogExceptInTest).toHaveBeenCalledWith('GitLab create webhook failed:', {
      status: 500,
      bodyExcerpt: providerBody,
      projectId: 123,
    });
  });

  it('returns a fixed message when a token check fails', async () => {
    mockFailureResponse(500, 'message: token check unavailable');

    const result = await validatePersonalAccessToken('pat-token');

    expect(result).toEqual({ valid: false, error: 'Failed to validate token: 500' });
    expect(mockLogExceptInTest).toHaveBeenCalledWith(
      '[validatePersonalAccessToken] Token info fetch failed',
      { status: 500, bodyExcerpt: 'message: token check unavailable' }
    );
  });

  it('writes one log line when a note creation request fails', async () => {
    mockFailureResponse(400, 'message: invalid note payload');

    await expect(createMRNote('test-token', 123, 7, 'body')).rejects.toThrow(
      /^GitLab MR note creation failed: 400$/
    );

    expect(mockLogExceptInTest).toHaveBeenCalledWith('GitLab MR note creation failed:', {
      status: 400,
      bodyExcerpt: 'message: invalid note payload',
      projectId: 123,
      mrIid: 7,
    });
  });
});
function discussionWithNote(input: {
  discussionId: string;
  noteId: number;
  authorId: number;
  authorUsername: string;
  body?: string;
}) {
  return {
    id: input.discussionId,
    individual_note: false,
    notes: [
      {
        id: input.noteId,
        body: input.body ?? 'comment body',
        author: { id: input.authorId, username: input.authorUsername, name: 'Author' },
        system: false,
        resolvable: true,
        resolved: false,
        position: {
          base_sha: 'base',
          start_sha: 'start',
          head_sha: 'head',
          old_path: 'src/file.ts',
          new_path: 'src/file.ts',
          position_type: 'text',
          old_line: null,
          new_line: 12,
        },
      },
    ],
  };
}

describe('webhook and project access token refusals', () => {
  const webhookOperations = [
    ['listProjectWebhooks', () => listProjectWebhooks('token', 123)],
    [
      'createProjectWebhook',
      () => createProjectWebhook('token', 123, 'https://example.com/webhook', 'webhook-secret'),
    ],
    [
      'updateProjectWebhook',
      () => updateProjectWebhook('token', 123, 456, 'https://example.com/webhook', 'secret'),
    ],
  ] as const;

  const projectAccessTokenOperations = [
    [
      'createProjectAccessToken',
      () => createProjectAccessToken('token', 123, 'Kilo bot', '2027-01-01'),
    ],
    ['listProjectAccessTokens', () => listProjectAccessTokens('token', 123)],
    ['rotateProjectAccessToken', () => rotateProjectAccessToken('token', 123, 456, '2027-01-01')],
    ['revokeProjectAccessToken', () => revokeProjectAccessToken('token', 123, 456)],
  ] as const;

  const allOperations = [...webhookOperations, ...projectAccessTokenOperations] as const;

  function mockRefusal(status: number) {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status,
      headers: new Headers(),
      text: async () => `refused: ${status}`,
      json: async () => ({}),
    });
  }
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it.each(allOperations)(
    '%s reports a 401 as an authentication failure that needs a reconnect',
    async (_name, run) => {
      mockRefusal(401);

      const refusal = await run().catch((error: unknown) => error);

      expect(refusal).toBeInstanceOf(GitLabAuthenticationError);
      expect(refusal).toMatchObject({ statusCode: 401, projectId: 123 });
      expect((refusal as Error).message).toContain('Reconnect the GitLab integration');
      expect((refusal as Error).message).not.toContain('Maintainer');
    }
  );

  it.each(allOperations)('%s keeps a 403 as a permission failure', async (name, run) => {
    const expectedError = webhookOperations.some(([operation]) => operation === name)
      ? GitLabWebhookPermissionError
      : GitLabProjectAccessTokenPermissionError;
    mockRefusal(403);

    const refusal = await run().catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(expectedError);
    expect(refusal).toMatchObject({ statusCode: 403, projectId: 123 });
    expect((refusal as Error).message).toContain('Requires Maintainer role or higher');
  });
});

describe('fetchMRInlineComments authorship', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('marks notes written by the token user as Kilo-authored', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          discussionWithNote({
            discussionId: 'd1',
            noteId: 1,
            authorId: 7,
            authorUsername: 'project_42_bot',
          }),
          discussionWithNote({
            discussionId: 'd2',
            noteId: 2,
            authorId: 300,
            authorUsername: 'contributor',
          }),
        ],
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 7, username: 'project_42_bot' }),
        headers: { get: () => null },
      });

    const comments = await fetchMRInlineComments('prat-token', 'group/project', 10);

    expect(comments.map(c => [c.id, c.authoredByKilo, c.user.username])).toEqual([
      [1, true, 'project_42_bot'],
      [2, false, 'contributor'],
    ]);
    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      'https://gitlab.com/api/v4/user',
      expect.anything()
    );
  });

  it('does not look up the token user when the MR has no inline notes', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => [{ id: 'd1', individual_note: true, notes: [] }],
      headers: { get: () => null },
    });

    const comments = await fetchMRInlineComments('prat-token', 'group/project', 10);

    expect(comments).toEqual([]);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('returns unattributed comments when the token-user lookup fails', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => [
          discussionWithNote({
            discussionId: 'd1',
            noteId: 1,
            authorId: 7,
            authorUsername: 'project_42_bot',
          }),
        ],
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        text: async () => 'Unauthorized',
        headers: { get: () => null },
      });

    const comments = await fetchMRInlineComments('prat-token', 'group/project', 10);

    expect(comments).toEqual([
      expect.objectContaining({
        id: 1,
        authoredByKilo: false,
        user: { username: 'project_42_bot' },
      }),
    ]);
  });
});
