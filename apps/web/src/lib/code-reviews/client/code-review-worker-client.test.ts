import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import type { ServiceTokenError as ServiceTokenErrorClass } from '@kilocode/service-token-client';
import { STS_ISSUERS } from '@kilocode/sts-contracts';
import type { CodeReviewPayload } from '../triggers/prepare-review-payload';
import type * as WorkerClientModule from './code-review-worker-client';

// The client end to end in one process: the real switch, the real lazy STS module and the shared
// token module, with the token client, the Vercel identity and the network faked.

jest.mock('@vercel/functions', () => ({
  getCache: jest.fn(() => ({})),
  waitUntil: jest.fn(),
}));

const mockIdentity = jest.fn(async () => 'exchanged-identity-token');
jest.mock('@kilocode/service-token-client/vercel', () => ({
  vercelIdentity: jest.fn(() => mockIdentity),
}));

const mockTokenGet = jest.fn<Promise<string>, [unknown, unknown]>();
const mockCreateHttpServiceTokens = jest.fn((_options: { stsUrl: string }) => ({
  get: mockTokenGet,
}));
jest.mock('@kilocode/service-token-client', () => ({
  ...(jest.requireActual('@kilocode/service-token-client') as Record<string, unknown>),
  createHttpServiceTokens: (options: { stsUrl: string }) => mockCreateHttpServiceTokens(options),
}));

const PRODUCTION = { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' };
const STAGING = { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' };
const LOCAL = {};
const WORKER_URL = 'https://code-review.example.test';
const LOCAL_URL = 'http://localhost:8789';
const SECRET = 'legacy-code-review-worker-token';
const TOKEN = 'sts-service-token';
const REVIEW_ID = 'rev-1';

type Runtime = Partial<Record<'VERCEL_ENV' | 'VERCEL_TARGET_ENV', string>>;
const runtimeNames = ['VERCEL_ENV', 'VERCEL_TARGET_ENV', 'CODE_REVIEW_WORKER_URL'] as const;
const savedRuntime = Object.fromEntries(runtimeNames.map(name => [name, process.env[name]]));
let mockFetch: jest.SpiedFunction<typeof fetch>;

function setEnv(name: (typeof runtimeNames)[number], value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

/** A fresh client module: it resolves its switch from configuration when it loads. */
async function loadClient(config: {
  auth?: string;
  secret?: string;
  url?: string;
  runtime?: Runtime;
}): Promise<{
  client: typeof WorkerClientModule;
  ServiceTokenError: typeof ServiceTokenErrorClass;
}> {
  const runtime = config.runtime ?? PRODUCTION;
  setEnv('VERCEL_ENV', runtime.VERCEL_ENV);
  setEnv('VERCEL_TARGET_ENV', runtime.VERCEL_TARGET_ENV);
  setEnv('CODE_REVIEW_WORKER_URL', config.url ?? WORKER_URL);
  jest.resetModules();
  jest.doMock('@kilocode/web-shared/lib/config.server', () => ({
    CODE_REVIEW_WORKER_AUTH_TOKEN: config.secret ?? SECRET,
    CODE_REVIEW_WORKER_SENDER_AUTH: config.auth ?? '',
  }));
  const client = await import('./code-review-worker-client');
  const { ServiceTokenError } = await import('@kilocode/service-token-client');
  jest.dontMock('@kilocode/web-shared/lib/config.server');
  return { client, ServiceTokenError };
}

const PAYLOAD: CodeReviewPayload = {
  reviewId: REVIEW_ID,
  authToken: 'user-token',
  sessionInput: { prompt: 'review', mode: 'code', model: 'model', upstreamBranch: 'main' },
  owner: { type: 'user', id: 'user-1', userId: 'user-1' },
  reviewAgents: { reviewType: 'standard', agents: [] },
};

/** One call per Worker action, with the URL and the response the action expects. */
const ACTIONS = {
  dispatch: {
    url: `${WORKER_URL}/review`,
    response: { reviewId: REVIEW_ID, status: 'queued' },
    call: (client: typeof WorkerClientModule) =>
      client.codeReviewWorkerClient.dispatchReview(PAYLOAD),
  },
  statusRead: {
    url: `${WORKER_URL}/reviews/${REVIEW_ID}/status`,
    response: { reviewId: REVIEW_ID, status: 'running' },
    call: (client: typeof WorkerClientModule) =>
      client.codeReviewWorkerClient.getReviewStatus(REVIEW_ID),
  },
  cancel: {
    url: `${WORKER_URL}/reviews/${REVIEW_ID}/cancel`,
    response: { success: true, reviewId: REVIEW_ID },
    call: (client: typeof WorkerClientModule) =>
      client.codeReviewWorkerClient.cancelReview(REVIEW_ID, 'superseded'),
  },
  retryFresh: {
    url: `${WORKER_URL}/reviews/${REVIEW_ID}/retry-fresh`,
    response: { success: true, reviewId: REVIEW_ID },
    call: (client: typeof WorkerClientModule) =>
      client.codeReviewWorkerClient.retryReviewFresh(REVIEW_ID, { reason: 'sandbox_error' }),
  },
} as const;

type Action = keyof typeof ACTIONS;
const ACTION_NAMES: Action[] = ['dispatch', 'statusRead', 'cancel', 'retryFresh'];

let consoleError: jest.SpyInstance;

beforeEach(() => {
  mockTokenGet.mockReset();
  mockCreateHttpServiceTokens.mockClear();
  mockFetch = jest.spyOn(globalThis, 'fetch');
  consoleError = jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  for (const name of runtimeNames) setEnv(name, savedRuntime[name]);
  jest.restoreAllMocks();
});

function answer(action: Action): void {
  mockFetch.mockResolvedValue(Response.json(ACTIONS[action].response));
}

describe('code review worker client, legacy', () => {
  test.each(ACTION_NAMES)('%s sends the worker token as before', async action => {
    answer(action);
    const { client } = await loadClient({ auth: 'legacy' });
    await expect(ACTIONS[action].call(client)).resolves.toBeTruthy();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe(ACTIONS[action].url);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${SECRET}`);
    expect(init?.redirect).toBeUndefined();
    expect(mockCreateHttpServiceTokens).not.toHaveBeenCalled();
  });

  test.each([
    ['Vercel production', PRODUCTION],
    ['staging', STAGING],
  ])('%s keeps the worker token when the switch is unset', async (_name, runtime) => {
    answer('statusRead');
    const { client } = await loadClient({ runtime });
    await client.codeReviewWorkerClient.getReviewStatus(REVIEW_ID);
    expect(new Headers(mockFetch.mock.calls[0]?.[1]?.headers).get('authorization')).toBe(
      `Bearer ${SECRET}`
    );
    expect(mockCreateHttpServiceTokens).not.toHaveBeenCalled();
  });

  test('legacy without the worker token refuses to load, as before', async () => {
    await expect(loadClient({ auth: 'legacy', secret: '' })).rejects.toThrow(
      'CODE_REVIEW_WORKER_AUTH_TOKEN not configured'
    );
  });

  test('a missing worker URL names only the URL', async () => {
    await expect(loadClient({ auth: 'sts', url: '' })).rejects.toThrow(
      /^CODE_REVIEW_WORKER_URL not configured$/
    );
  });
});

describe('code review worker client, sts', () => {
  test.each(ACTION_NAMES)(
    '%s under sts sends only its own scope from production STS, never the worker token',
    async action => {
      answer(action);
      mockTokenGet.mockResolvedValue(TOKEN);
      const { client } = await loadClient({ auth: 'sts' });
      await expect(ACTIONS[action].call(client)).resolves.toBeTruthy();

      expect(mockCreateHttpServiceTokens).toHaveBeenCalledTimes(1);
      expect(mockCreateHttpServiceTokens.mock.calls[0]?.[0].stsUrl).toBe(STS_ISSUERS.production);
      expect(mockTokenGet).toHaveBeenCalledTimes(1);
      expect(mockTokenGet.mock.calls[0]?.[0]).toEqual(client.CODE_REVIEW_WORKER_SCOPES[action]);

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [url, init] = mockFetch.mock.calls[0] ?? [];
      expect(url).toBe(ACTIONS[action].url);
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
      expect(JSON.stringify(init)).not.toContain(SECRET);
      expect(init?.redirect).toBe('error');
    }
  );

  test('the four scopes are those of the E4 scope handoff', async () => {
    const { client } = await loadClient({ auth: 'legacy' });
    expect(client.CODE_REVIEW_WORKER_SCOPES).toEqual({
      dispatch: { audience: 'code-review', scope: 'code-review:review.dispatch' },
      statusRead: { audience: 'code-review', scope: 'code-review:review.status-read' },
      cancel: { audience: 'code-review', scope: 'code-review:review.cancel' },
      retryFresh: { audience: 'code-review', scope: 'code-review:review.retry-fresh' },
    });
  });

  test('sts needs no worker token', async () => {
    answer('statusRead');
    mockTokenGet.mockResolvedValue(TOKEN);
    const { client } = await loadClient({ auth: 'sts', secret: '' });
    await expect(client.codeReviewWorkerClient.getReviewStatus(REVIEW_ID)).resolves.toBeTruthy();
  });

  test('a process outside Vercel mints from development STS for a loopback worker', async () => {
    answer('statusRead');
    mockTokenGet.mockResolvedValue(TOKEN);
    const { client } = await loadClient({ auth: 'sts', url: LOCAL_URL, runtime: LOCAL });
    await client.codeReviewWorkerClient.getReviewStatus(REVIEW_ID);
    expect(mockCreateHttpServiceTokens.mock.calls[0]?.[0].stsUrl).toBe(STS_ISSUERS.development);
    expect(mockFetch.mock.calls[0]?.[0]).toBe(`${LOCAL_URL}/reviews/${REVIEW_ID}/status`);
  });

  test.each([
    ['a denied mint', 'denied'],
    ['an unavailable STS', 'unavailable'],
    ['a failed Vercel identity', 'identity'],
  ] as const)('%s fails the call; nothing is sent', async (_name, kind) => {
    const { client, ServiceTokenError } = await loadClient({ auth: 'sts' });
    const scope = client.CODE_REVIEW_WORKER_SCOPES.dispatch;
    mockTokenGet.mockRejectedValue(
      kind === 'denied'
        ? new ServiceTokenError({ reason: 'denied', deniedReason: 'unknown_scope' }, scope)
        : kind === 'unavailable'
          ? new ServiceTokenError({ reason: 'unavailable', retryAfterSeconds: 4 }, scope)
          : new Error('no Vercel token for the STS audience: exchange answered 500')
    );

    await expect(client.codeReviewWorkerClient.dispatchReview(PAYLOAD)).rejects.toThrow(
      'No STS service token for code-review:review.dispatch; try again'
    );
    expect(mockFetch).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledWith(
      'code review worker client: no STS token; request refused',
      kind === 'denied'
        ? { errorName: 'ServiceTokenError', reason: 'denied', deniedReason: 'unknown_scope' }
        : kind === 'unavailable'
          ? { errorName: 'ServiceTokenError', reason: 'unavailable' }
          : { errorName: 'Error' }
    );
  });

  test('a mint slower than the 10 s deadline fails the call then; nothing is sent', async () => {
    const { client } = await loadClient({ auth: 'sts' });
    jest.useFakeTimers();
    try {
      mockTokenGet.mockReturnValue(Promise.withResolvers<string>().promise);
      const outcome = expect(client.codeReviewWorkerClient.dispatchReview(PAYLOAD)).rejects.toThrow(
        'Request timeout after 10000ms'
      );
      await jest.advanceTimersByTimeAsync(9_999);
      expect(mockFetch).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(1);
      await outcome;
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('the mint and the request share one 10 s deadline', async () => {
    const { client } = await loadClient({ auth: 'sts' });
    jest.useFakeTimers();
    try {
      mockTokenGet.mockImplementation(() => {
        const minted = Promise.withResolvers<string>();
        setTimeout(() => minted.resolve(TOKEN), 6_000);
        return minted.promise;
      });
      mockFetch.mockImplementation(() => Promise.withResolvers<Response>().promise);
      const outcome = expect(
        client.codeReviewWorkerClient.getReviewStatus(REVIEW_ID)
      ).rejects.toThrow('Request timeout after 10000ms');
      await jest.advanceTimersByTimeAsync(6_000);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      const signal = mockFetch.mock.calls[0]?.[1]?.signal;
      expect(signal?.aborted).toBe(false);
      // 4 s after the mint, not 10: the request only gets what the mint left.
      await jest.advanceTimersByTimeAsync(4_000);
      await outcome;
      expect(signal?.aborted).toBe(true);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('code review worker client, refused', () => {
  test.each([
    ['an invalid switch', { auth: 'STS' }, 'invalid_auth', 'must be legacy or sts'],
    ['sts on staging', { auth: 'sts', runtime: STAGING }, 'sts_production_only', 'production'],
    [
      'sts to a plaintext worker URL',
      { auth: 'sts', url: 'http://code-review.example.test' },
      'insecure_url',
      'needs an https receiver URL',
    ],
  ] as const)('%s fails every call; nothing is sent', async (_name, config, reason, message) => {
    const { client } = await loadClient(config);
    for (const action of ACTION_NAMES) {
      await expect(ACTIONS[action].call(client)).rejects.toThrow(message);
    }
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockCreateHttpServiceTokens).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledWith(
      'code review worker client: invalid sender configuration; request refused',
      { reason }
    );
  });
});
