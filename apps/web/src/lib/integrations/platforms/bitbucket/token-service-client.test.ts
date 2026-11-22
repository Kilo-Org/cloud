import type * as ServerConfig from '@kilocode/web-shared/lib/config.server';

const mockConfig = {
  gitTokenServiceUrl: 'https://git-token-service.example.test',
  nextAuthSecret: 'bitbucket-repository-list-test-secret',
};

jest.mock('@kilocode/web-shared/lib/config.server', () => {
  const actual = jest.requireActual<typeof ServerConfig>('@kilocode/web-shared/lib/config.server');
  return {
    ...actual,
    get GIT_TOKEN_SERVICE_API_URL() {
      return mockConfig.gitTokenServiceUrl;
    },
    get NEXTAUTH_SECRET() {
      return mockConfig.nextAuthSecret;
    },
  };
});

import { BITBUCKET_MAX_REPOSITORY_ITEMS } from '@kilocode/worker-utils/bitbucket-workspace-access-token';
import {
  BitbucketRepositoryListResultSchema,
  fetchBitbucketRepositoriesFromTokenService,
} from './token-service-client';

const REPOSITORY_LIST_RESPONSE_MAX_BYTES = 4_194_304;
const REPOSITORY_LIST_URL = `${mockConfig.gitTokenServiceUrl}/internal/bitbucket/repositories`;
const WORKSPACE_UUID = '11111111-1111-4111-8111-111111111111';

function repository(index: number) {
  return {
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
    workspaceUuid: WORKSPACE_UUID,
    name: `repository-${index}`,
    fullName: `acme/repository-${index}`,
    private: true,
  };
}

function repositories(count: number) {
  return Array.from({ length: count }, (_value, index) => repository(index));
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function chunkedJsonResponse(totalBytes: number): Response {
  const chunkBytes = 1_048_576;
  const encoder = new TextEncoder();
  let emittedBytes = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (emittedBytes >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(chunkBytes, totalBytes - emittedBytes);
      controller.enqueue(encoder.encode('x'.repeat(size)));
      emittedBytes += size;
    },
  });
  return new Response(body, { headers: { 'content-type': 'application/json' } });
}

function pendingStreamBody(): ReadableStream<Uint8Array> {
  // A body that never yields: the call resolves only while the declared size is
  // checked before the stream is read.
  return new ReadableStream<Uint8Array>({
    pull() {
      return new Promise(() => {});
    },
  });
}

function mockFetchResponse(response: Response) {
  return jest.spyOn(globalThis, 'fetch').mockImplementation(async () => response);
}

describe('BitbucketRepositoryListResultSchema', () => {
  it.each(['insufficient_permissions', 'invalid_request'] as const)(
    'accepts the static token-service %s result',
    status => {
      expect(BitbucketRepositoryListResultSchema.parse({ status })).toEqual({ status });
    }
  );
});

describe('fetchBitbucketRepositoriesFromTokenService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('accepts a repository listing at the maximum repository count', async () => {
    const fetchMock = mockFetchResponse(
      jsonResponse({
        status: 'available',
        repositories: repositories(BITBUCKET_MAX_REPOSITORY_ITEMS),
      })
    );

    const result = await fetchBitbucketRepositoriesFromTokenService('repository-list-user');

    expect(result.status).toBe('available');
    expect(result.status === 'available' ? result.repositories.length : 0).toBe(
      BITBUCKET_MAX_REPOSITORY_ITEMS
    );
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(REPOSITORY_LIST_URL);
    expect(init?.redirect).toBe('manual');
  });

  it('answers temporarily_unavailable for a listing above the maximum repository count', async () => {
    mockFetchResponse(
      jsonResponse({
        status: 'available',
        repositories: repositories(BITBUCKET_MAX_REPOSITORY_ITEMS + 1),
      })
    );

    await expect(
      fetchBitbucketRepositoriesFromTokenService('repository-list-user')
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
  });

  it('answers temporarily_unavailable for a declared Content-Length above the response byte ceiling', async () => {
    const response = new Response(pendingStreamBody(), {
      headers: {
        'content-type': 'application/json',
        'content-length': String(REPOSITORY_LIST_RESPONSE_MAX_BYTES + 1),
      },
    });
    mockFetchResponse(response);

    await expect(
      fetchBitbucketRepositoriesFromTokenService('repository-list-user')
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
    expect(response.bodyUsed).toBe(false);
  });

  it('answers temporarily_unavailable for a streamed body above the response byte ceiling', async () => {
    mockFetchResponse(chunkedJsonResponse(REPOSITORY_LIST_RESPONSE_MAX_BYTES + 1_048_576));

    await expect(
      fetchBitbucketRepositoriesFromTokenService('repository-list-user')
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
  });

  it('answers temporarily_unavailable for a non-JSON content type', async () => {
    mockFetchResponse(
      new Response(JSON.stringify({ status: 'available', repositories: [] }), {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      })
    );

    await expect(
      fetchBitbucketRepositoriesFromTokenService('repository-list-user')
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
  });

  it('answers temporarily_unavailable for a response reported as redirected', async () => {
    const response = new Response(pendingStreamBody(), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    Object.defineProperty(response, 'redirected', { value: true });
    mockFetchResponse(response);

    await expect(
      fetchBitbucketRepositoriesFromTokenService('repository-list-user')
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
    expect(response.bodyUsed).toBe(false);
  });

  it('answers temporarily_unavailable for a 302 response with manual redirects', async () => {
    const fetchMock = mockFetchResponse(
      new Response(null, {
        status: 302,
        headers: { location: 'https://redirected.example.test/' },
      })
    );

    await expect(
      fetchBitbucketRepositoriesFromTokenService('repository-list-user')
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.redirect).toBe('manual');
  });
});
