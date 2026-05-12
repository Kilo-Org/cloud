import { describe, it, expect } from 'vitest';
import { queryContainerApplications } from '../src/alerting/container-capacity-query';

const ACCOUNT_ID = 'test-account-123';
const API_TOKEN = 'test-token-abc';

type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

function makeSecret(value: string | null): SecretsStoreSecret {
  return { get: async () => value } as unknown as SecretsStoreSecret;
}

function makeEnv(token = API_TOKEN): {
  O11Y_CF_ACCOUNT_ID: string;
  O11Y_CF_CONTAINERS_API_TOKEN: SecretsStoreSecret;
} {
  return {
    O11Y_CF_ACCOUNT_ID: ACCOUNT_ID,
    O11Y_CF_CONTAINERS_API_TOKEN: makeSecret(token),
  };
}

function makeListResponse(apps: unknown[], totalPages = 1, page = 1): object {
  return {
    success: true,
    result: apps,
    result_info: {
      page,
      per_page: 20,
      total_count: apps.length,
      total_pages: totalPages,
    },
    errors: [],
    messages: [],
  };
}

function makeDetailResponse(app: object): object {
  return {
    success: true,
    result: app,
    errors: [],
    messages: [],
  };
}

const sandboxListApp = {
  id: 'sandbox-id',
  name: 'cloud-agent-next-sandbox',
  instances: 99,
  health: { instances: { active: 95, healthy: 3, starting: 1 } },
};

const sandboxDetailApp = {
  id: 'sandbox-id',
  name: 'cloud-agent-next-sandbox',
  instances: 99,
  max_instances: 250,
  health: { instances: { active: 95, healthy: 3, starting: 1 } },
};

const smallListApp = {
  id: 'small-id',
  name: 'cloud-agent-next-sandboxsmall',
  instances: 20,
};

const smallDetailApp = {
  id: 'small-id',
  name: 'cloud-agent-next-sandboxsmall',
  instances: 20,
  max_instances: 100,
};

const unmonitoredListApp = {
  id: 'other-id',
  name: 'some-other-app',
  instances: 5,
};

function makeFetch(responses: Map<string, object>): FetchFn {
  return async (url: string) => {
    const body = responses.get(url);
    if (!body) {
      return new Response(JSON.stringify({ success: false, errors: ['not found'] }), {
        status: 404,
      });
    }
    return new Response(JSON.stringify(body), { status: 200 });
  };
}

describe('queryContainerApplications', () => {
  it('fetches monitored applications with max_instances from detail endpoint', async () => {
    const responses = new Map<string, object>([
      [
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/containers/dash/applications?page=1&per_page=20`,
        makeListResponse([sandboxListApp, unmonitoredListApp]),
      ],
      [
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/containers/applications/sandbox-id`,
        makeDetailResponse(sandboxDetailApp),
      ],
    ]);

    const apps = await queryContainerApplications(makeEnv(), makeFetch(responses));

    expect(apps).toHaveLength(1);
    expect(apps[0].name).toBe('cloud-agent-next-sandbox');
    expect(apps[0].instances).toBe(99);
    expect(apps[0].maxInstances).toBe(250);
    expect(apps[0].health?.instances.active).toBe(95);
  });

  it('sends Authorization header with the token', async () => {
    let capturedHeaders: HeadersInit | undefined;
    const fetchFn: FetchFn = async (url, init) => {
      capturedHeaders = init?.headers;
      if (url.includes('/dash/applications')) {
        return new Response(JSON.stringify(makeListResponse([])), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    };

    await queryContainerApplications(makeEnv(), fetchFn);

    const headers = new Headers(capturedHeaders);
    expect(headers.get('Authorization')).toBe(`Bearer ${API_TOKEN}`);
  });

  it('constructs the list URL with the correct account ID', async () => {
    const calledUrls: string[] = [];
    const fetchFn: FetchFn = async url => {
      calledUrls.push(url);
      return new Response(JSON.stringify(makeListResponse([])), { status: 200 });
    };

    await queryContainerApplications(makeEnv(), fetchFn);

    expect(calledUrls[0]).toContain(`/accounts/${ACCOUNT_ID}/containers/dash/applications`);
  });

  it('handles pagination by fetching all pages', async () => {
    const page1Response = makeListResponse([sandboxListApp], 2, 1);
    const page2Response = makeListResponse([smallListApp], 2, 2);
    const responses = new Map<string, object>([
      [
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/containers/dash/applications?page=1&per_page=20`,
        page1Response,
      ],
      [
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/containers/dash/applications?page=2&per_page=20`,
        page2Response,
      ],
      [
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/containers/applications/sandbox-id`,
        makeDetailResponse(sandboxDetailApp),
      ],
      [
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/containers/applications/small-id`,
        makeDetailResponse(smallDetailApp),
      ],
    ]);

    const apps = await queryContainerApplications(makeEnv(), makeFetch(responses));

    expect(apps).toHaveLength(2);
    expect(apps.map(a => a.name).sort()).toEqual([
      'cloud-agent-next-sandbox',
      'cloud-agent-next-sandboxsmall',
    ]);
  });

  it('returns empty array when no monitored apps are found in the list', async () => {
    const fetchFn: FetchFn = async () =>
      new Response(JSON.stringify(makeListResponse([unmonitoredListApp])), { status: 200 });

    const apps = await queryContainerApplications(makeEnv(), fetchFn);
    expect(apps).toEqual([]);
  });

  it('throws on non-OK list response', async () => {
    const fetchFn: FetchFn = async () =>
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });

    await expect(queryContainerApplications(makeEnv(), fetchFn)).rejects.toThrow(/401/);
  });

  it('throws on non-OK detail response', async () => {
    const responses = new Map<string, object>([
      [
        `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/containers/dash/applications?page=1&per_page=20`,
        makeListResponse([sandboxListApp]),
      ],
    ]);
    const fetchFn: FetchFn = async url => {
      if (url.includes('/dash/applications')) {
        return new Response(JSON.stringify(makeListResponse([sandboxListApp])), { status: 200 });
      }
      return new Response('forbidden', { status: 403 });
    };

    await expect(queryContainerApplications(makeEnv(), fetchFn)).rejects.toThrow(/403/);
  });

  it('throws on invalid list response schema', async () => {
    const fetchFn: FetchFn = async () =>
      new Response(JSON.stringify({ unexpected: 'shape' }), { status: 200 });

    await expect(queryContainerApplications(makeEnv(), fetchFn)).rejects.toThrow();
  });

  it('throws on invalid detail response schema', async () => {
    const fetchFn: FetchFn = async url => {
      if (url.includes('/dash/applications')) {
        return new Response(JSON.stringify(makeListResponse([sandboxListApp])), { status: 200 });
      }
      return new Response(JSON.stringify({ success: true, result: { wrong: 'shape' } }), {
        status: 200,
      });
    };

    await expect(queryContainerApplications(makeEnv(), fetchFn)).rejects.toThrow();
  });
});
