import { describe, expect, it, beforeEach, afterEach } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import {
  authorizeRepository,
  authorizeWorkspace,
  BITBUCKET_WORKSPACE_ACCESS_TOKEN_AUDIENCE,
  classifyBitbucketError,
  classifyBitbucketStatus,
  fetchBitbucketWorkspaceAccessToken,
  BitbucketApiStatusError,
  BitbucketReviewError,
  type BitbucketReviewOwner,
} from './bitbucket-authorization';

const mockGetBitbucketWorkspaceAccessTokenStatus = jest.fn();
const mockReadCachedRepositories = jest.fn();

jest.mock('@/lib/integrations/platforms/bitbucket/workspace-access-token-repository-cache', () => ({
  getBitbucketWorkspaceAccessTokenStatus: (...args: unknown[]) =>
    mockGetBitbucketWorkspaceAccessTokenStatus(...args),
  readCachedBitbucketWorkspaceAccessTokenRepositories: (input: unknown) =>
    mockReadCachedRepositories(input),
}));

jest.mock('@/lib/config.server', () => ({
  GIT_TOKEN_SERVICE_API_URL: 'https://token-service.example.com',
}));

jest.mock('@/lib/tokens', () => ({
  generateInternalServiceToken: jest.fn(() => 'svc-mock-token'),
  TOKEN_EXPIRY: { fiveMinutes: 300 },
}));

jest.mock('@/lib/utils.server', () => ({
  logExceptInTest: () => {},
  warnExceptInTest: () => {},
}));

const ORG_OWNER: BitbucketReviewOwner = {
  type: 'organization',
  organizationId: 'org_1',
  userId: 'user_1',
};
const USER_OWNER: BitbucketReviewOwner = { type: 'user', userId: 'user_1' };

const WORKSPACE = { uuid: '12345678-1234-1234-1234-123456789012', slug: 'acme' };

function connectedStatus() {
  return {
    status: 'connected',
    integrationId: 'intg_1',
    workspace: { ...WORKSPACE, displayName: 'Acme' },
  };
}

function cacheAvailable() {
  return {
    status: 'available',
    repositories: [
      {
        id: '87654321-4321-4321-4321-210987654321',
        workspaceUuid: WORKSPACE.uuid,
        name: 'repo',
        fullName: 'acme/repo',
        private: true,
        defaultBranch: 'main',
      },
      {
        id: '11111111-2222-3333-4444-555555555555',
        workspaceUuid: WORKSPACE.uuid,
        name: 'other',
        fullName: 'acme/other',
        private: false,
      },
    ],
    syncedAt: '2026-09-06T00:00:00.000Z',
  };
}

let fetchMock: jest.Mock;

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Await a rejection and return it typed, without a success-branch union. */
async function captureRejection(promise: Promise<unknown>): Promise<BitbucketReviewError> {
  try {
    await promise;
  } catch (reason) {
    return reason as BitbucketReviewError;
  }
  throw new Error('Expected the call to reject.');
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetBitbucketWorkspaceAccessTokenStatus.mockResolvedValue(connectedStatus());
  mockReadCachedRepositories.mockResolvedValue(cacheAvailable());
  fetchMock = jest.fn();
  fetchMock.mockImplementation(async () =>
    jsonResponse({ status: 'available', token: 'at-mock-token', workspace: WORKSPACE })
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('organization-only ownership', () => {
  it('refuses a user owner with a clear not-found naming the organization context', async () => {
    const error = await captureRejection(authorizeWorkspace(USER_OWNER));

    expect(error).toBeInstanceOf(BitbucketReviewError);
    expect(error.kind).toBe('not_found');
    expect(error.retryable).toBe(false);
    expect(error.message).toContain('organization');
    expect(mockGetBitbucketWorkspaceAccessTokenStatus).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a user owner on authorizeRepository before any identity work', async () => {
    const error = await captureRejection(authorizeRepository(USER_OWNER, 'acme', 'repo'));

    expect(error.kind).toBe('not_found');
    expect(mockGetBitbucketWorkspaceAccessTokenStatus).not.toHaveBeenCalled();
    expect(mockReadCachedRepositories).not.toHaveBeenCalled();
  });
});

describe('authorizeWorkspace', () => {
  it('resolves the org integration identity and returns the released token', async () => {
    const access = await authorizeWorkspace(ORG_OWNER);

    expect(access.accessToken).toBe('at-mock-token');
    expect(access.workspace).toEqual(WORKSPACE);
    expect(mockGetBitbucketWorkspaceAccessTokenStatus).toHaveBeenCalledWith('org_1');
  });

  it('maps a missing connection to non-retryable not_found', async () => {
    mockGetBitbucketWorkspaceAccessTokenStatus.mockResolvedValue({ status: 'not_connected' });

    await expect(authorizeWorkspace(ORG_OWNER)).rejects.toMatchObject({
      kind: 'not_found',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a degraded connection to non-retryable not_found', async () => {
    mockGetBitbucketWorkspaceAccessTokenStatus.mockResolvedValue({
      status: 'reconnect_required',
      workspace: null,
      integrationId: null,
    });

    await expect(authorizeWorkspace(ORG_OWNER)).rejects.toMatchObject({ kind: 'not_found' });
  });
});

describe('fetchBitbucketWorkspaceAccessToken — release contract', () => {
  const releaseInput = {
    userId: 'user_1',
    organizationId: 'org_1',
    integrationId: 'intg_1',
    expectedWorkspace: WORKSPACE,
  };

  it('mints an internal service token for the workspace-access-token audience', async () => {
    await fetchBitbucketWorkspaceAccessToken(releaseInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://token-service.example.com/internal/bitbucket/workspace-access-token');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer svc-mock-token');
    expect(JSON.parse(init.body)).toEqual({
      integrationId: 'intg_1',
      workspaceUuid: WORKSPACE.uuid,
      workspaceSlug: WORKSPACE.slug,
    });
  });

  it('degrades a transport failure to retryable temporarily_unavailable', async () => {
    fetchMock.mockImplementation(async () => {
      throw new TypeError('fetch failed');
    });

    const result = await fetchBitbucketWorkspaceAccessToken(releaseInput);

    expect(result.status).toBe('temporarily_unavailable');
  });

  it('degrades a non-JSON release response to temporarily_unavailable', async () => {
    fetchMock.mockImplementation(
      async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } })
    );

    const result = await fetchBitbucketWorkspaceAccessToken(releaseInput);

    expect(result.status).toBe('temporarily_unavailable');
  });

  it('degrades a non-2xx release response to temporarily_unavailable', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ error: 'unauthorized' }, 401));

    const result = await fetchBitbucketWorkspaceAccessToken(releaseInput);

    expect(result.status).toBe('temporarily_unavailable');
  });

  it('refuses a released token whose workspace echo does not match the request', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        status: 'available',
        token: 'at-mock-token',
        workspace: { uuid: '99999999-9999-9999-9999-999999999999', slug: 'other' },
      })
    );

    const result = await fetchBitbucketWorkspaceAccessToken(releaseInput);

    expect(result.status).toBe('reconnect_required');
  });

  it('passes a structured not_connected through to the caller', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ status: 'not_connected' }));

    const result = await fetchBitbucketWorkspaceAccessToken(releaseInput);

    expect(result.status).toBe('not_connected');
  });

  it('exposes the operation-specific audience for the release endpoint', () => {
    expect(BITBUCKET_WORKSPACE_ACCESS_TOKEN_AUDIENCE).toBe(
      'git-token-service:bitbucket-workspace-access-token'
    );
  });
});

describe('authorizeRepository — identity resolution', () => {
  it('resolves workspace and repository identity from the integration cache', async () => {
    const access = await authorizeRepository(ORG_OWNER, 'acme', 'repo');

    expect(access.workspace).toEqual(WORKSPACE);
    expect(access.repository).toMatchObject({
      uuid: '87654321-4321-4321-4321-210987654321',
      slug: 'repo',
      fullName: 'acme/repo',
    });
    expect(access.accessToken).toBe('at-mock-token');
    expect(mockReadCachedRepositories).toHaveBeenCalledWith({
      organizationId: 'org_1',
      expectedIntegrationId: 'intg_1',
    });
  });

  it('matches the requested repository case-insensitively and returns the canonical slug', async () => {
    const access = await authorizeRepository(ORG_OWNER, 'ACME', 'Repo');

    expect(access.repository.slug).toBe('repo');
    expect(access.repository.fullName).toBe('acme/repo');
  });

  it('releases the token only after the repository identity resolves', async () => {
    mockReadCachedRepositories.mockResolvedValue(cacheAvailable());

    await expect(authorizeRepository(ORG_OWNER, 'acme', 'missing')).rejects.toMatchObject({
      kind: 'not_found',
      retryable: false,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a repository outside the connected workspace as not_found', async () => {
    await expect(authorizeRepository(ORG_OWNER, 'other-workspace', 'repo')).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mockReadCachedRepositories).not.toHaveBeenCalled();
  });

  it('refuses a repository slug carrying a path segment', async () => {
    await expect(authorizeRepository(ORG_OWNER, 'acme', 'repo/pull')).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(mockReadCachedRepositories).not.toHaveBeenCalled();
  });

  it('maps an insufficient-permission repository cache to non-retryable forbidden', async () => {
    mockReadCachedRepositories.mockResolvedValue({ status: 'insufficient_permissions' });

    const error = await captureRejection(authorizeRepository(ORG_OWNER, 'acme', 'repo'));

    expect(error).toBeInstanceOf(BitbucketReviewError);
    expect(error.kind).toBe('forbidden');
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/reconnect/i);
    expect(error.message).toMatch(/scope/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps an unavailable repository cache to retryable', async () => {
    mockReadCachedRepositories.mockResolvedValue({ status: 'temporarily_unavailable' });

    await expect(authorizeRepository(ORG_OWNER, 'acme', 'repo')).rejects.toMatchObject({
      kind: 'retryable',
      retryable: true,
    });
  });
});

describe('credential failure classification', () => {
  it('maps release failures onto the mobile error states', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ status: 'not_connected' }));

    await expect(authorizeWorkspace(ORG_OWNER)).rejects.toMatchObject({
      kind: 'not_found',
    });

    fetchMock.mockImplementation(async () => jsonResponse({ status: 'invalid_request' }));

    await expect(authorizeWorkspace(ORG_OWNER)).rejects.toMatchObject({
      kind: 'bad_request',
    });

    fetchMock.mockImplementation(async () => jsonResponse({ status: 'temporarily_unavailable' }));

    await expect(authorizeWorkspace(ORG_OWNER)).rejects.toMatchObject({
      kind: 'retryable',
      retryable: true,
    });
  });

  it('classifies provider statuses onto non-retryable and retryable kinds', () => {
    expect(classifyBitbucketStatus(404).kind).toBe('not_found');
    expect(classifyBitbucketStatus(403).kind).toBe('forbidden');
    expect(classifyBitbucketStatus(409).kind).toBe('stale_head');
    expect(classifyBitbucketStatus(409).retryable).toBe(false);
    expect(classifyBitbucketStatus(502).retryable).toBe(true);
    expect(classifyBitbucketStatus(429).kind).toBe('retryable');
  });

  it('extracts the status from transport error message tails', () => {
    const classified = classifyBitbucketError(new Error('Bitbucket GET request failed: 404'));
    expect(classified.kind).toBe('not_found');
  });

  it('never echoes provider bodies into the classified message', () => {
    const leaked = new BitbucketApiStatusError(
      403,
      'Bitbucket POST request failed: 403 {"error":"token at-secret for workspace acme denied"}'
    );
    const classified = classifyBitbucketError(leaked);
    expect(classified.kind).toBe('forbidden');
    expect(classified.message).not.toContain('at-secret');
  });

  it('classifies network failures as retryable', () => {
    expect(classifyBitbucketError(new TypeError('fetch failed')).retryable).toBe(true);
  });

  it('maps broker TRPC errors onto the review error kinds', async () => {
    mockReadCachedRepositories.mockResolvedValue(cacheAvailable());
    fetchMock.mockImplementation(async () => {
      throw new TRPCError({ code: 'SERVICE_UNAVAILABLE' });
    });

    // The release client itself degrades to temporarily_unavailable, which the
    // workspace layer maps to a retryable review error.
    await expect(authorizeWorkspace(ORG_OWNER)).rejects.toMatchObject({ kind: 'retryable' });
  });
});
