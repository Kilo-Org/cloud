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
  validateGitLabInstance,
  validatePersonalAccessToken,
  createProjectWebhook,
  deleteProjectWebhook,
  fetchGitLabProjects,
  fetchGitLabRootTextFileAtRef,
  fetchGitLabRepositorySize,
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
