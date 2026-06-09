import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;
    ctx: ExecutionContext;
    constructor() {
      this.env = undefined;
      this.ctx = {
        waitUntil: () => {},
        passThroughOnException: () => {},
      } as unknown as ExecutionContext;
    }
  },
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(),
}));

vi.mock('./dos/SessionIngestDO', () => ({
  getSessionIngestDO: vi.fn(),
}));

vi.mock('./dos/UserConnectionDO', () => ({
  getUserConnectionDO: vi.fn(),
}));

vi.mock('./services/session-export', () => ({
  getSessionExport: vi.fn(),
}));

import { app } from './index';
import { getWorkerDb } from '@kilocode/db/client';
import { getSessionIngestDO } from './dos/SessionIngestDO';
import { getUserConnectionDO } from './dos/UserConnectionDO';
import { getSessionExport } from './services/session-export';

type TestBindings = {
  HYPERDRIVE: { connectionString: string };
  SESSION_INGEST_DO: unknown;
  SESSION_ACCESS_CACHE_DO: unknown;
  NEXTAUTH_SECRET: unknown;
  NEXTAUTH_SECRET_RAW?: string;
  INTERNAL_API_SECRET_PROD: { get: () => Promise<string> };
};

function makeDbFakes() {
  const selectResult = vi.fn<() => Promise<unknown[]>>(async () => []);
  const select = {
    from: vi.fn(() => select),
    where: vi.fn(() => select),
    limit: vi.fn(() => select),
    then: vi.fn((resolve: (v: unknown) => unknown) => resolve(selectResult())),
  };

  const db = {
    select: vi.fn(() => select),
  };

  return { db, selectResult };
}

const defaultEnv: TestBindings = {
  HYPERDRIVE: { connectionString: 'postgres://test' },
  SESSION_INGEST_DO: {},
  SESSION_ACCESS_CACHE_DO: {},
  NEXTAUTH_SECRET: {},
  NEXTAUTH_SECRET_RAW: 'secret',
  INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
};

describe('internal user events route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
      configurable: true,
      value: (left: ArrayBuffer, right: ArrayBuffer) => {
        const leftBytes = new Uint8Array(left);
        const rightBytes = new Uint8Array(right);
        return (
          leftBytes.length === rightBytes.length &&
          leftBytes.every((byte, i) => byte === rightBytes[i])
        );
      },
    });
  });

  function request(
    path = '/internal/user/events?connectionId=facade-connection',
    headers: Record<string, string> = {}
  ) {
    return app.request(
      path,
      {
        headers: {
          'X-Internal-Secret': 'internal-secret',
          'X-Kilo-User-Id': 'usr_test',
          Upgrade: 'websocket',
          ...headers,
        },
      },
      defaultEnv
    );
  }

  it('returns 401 for an invalid internal secret', async () => {
    const response = await request(undefined, { 'X-Internal-Secret': 'wrong-secret' });

    expect(response.status).toBe(401);
    expect(getUserConnectionDO).not.toHaveBeenCalled();
  });

  it('returns 426 unless Upgrade is websocket case-insensitively', async () => {
    const response = await request(undefined, { Upgrade: 'h2c' });

    expect(response.status).toBe(426);
    expect(getUserConnectionDO).not.toHaveBeenCalled();
  });

  it.each([
    [{ 'X-Kilo-User-Id': '' }, '/internal/user/events?connectionId=facade-connection'],
    [{ 'X-Kilo-User-Id': ' '.repeat(3) }, '/internal/user/events?connectionId=facade-connection'],
    [{ 'X-Kilo-User-Id': 'u'.repeat(257) }, '/internal/user/events?connectionId=facade-connection'],
    [{}, '/internal/user/events'],
    [{}, '/internal/user/events?connectionId='],
    [{}, '/internal/user/events?connectionId=one&connectionId=two'],
    [{}, `/internal/user/events?connectionId=${'c'.repeat(257)}`],
  ])('returns 400 for invalid identity or connection', async (headers, path) => {
    const response = await request(path, headers);

    expect(response.status).toBe(400);
    expect(getUserConnectionDO).not.toHaveBeenCalled();
  });

  it('forwards an authenticated upgrade to the user DO web path', async () => {
    const forwardedResponse = new Response('forwarded', { status: 200 });
    const fetch = vi.fn(async (_request: Request) => forwardedResponse);
    vi.mocked(getUserConnectionDO).mockReturnValue({ fetch } as never);

    const response = await request('/internal/user/events?connectionId=facade%2Fconnection', {
      Upgrade: 'WebSocket',
    });

    expect(response).toBe(forwardedResponse);
    expect(getUserConnectionDO).toHaveBeenCalledWith(defaultEnv, { kiloUserId: 'usr_test' });
    expect(fetch).toHaveBeenCalledOnce();
    const forwardedRequest = fetch.mock.calls[0]?.[0];
    expect(forwardedRequest).toBeInstanceOf(Request);
    if (!(forwardedRequest instanceof Request)) throw new Error('Expected forwarded Request');
    const forwardedUrl = new URL(forwardedRequest.url);
    expect(forwardedUrl.pathname).toBe('/web');
    expect(forwardedUrl.searchParams.getAll('connectionId')).toEqual(['facade/connection']);
    expect(forwardedRequest.headers.get('Upgrade')).toBe('websocket');
  });
});

describe('internal session export route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    Object.defineProperty(crypto.subtle, 'timingSafeEqual', {
      configurable: true,
      value: (left: ArrayBuffer, right: ArrayBuffer) => {
        const leftBytes = new Uint8Array(left);
        const rightBytes = new Uint8Array(right);
        return (
          leftBytes.length === rightBytes.length &&
          leftBytes.every((byte, i) => byte === rightBytes[i])
        );
      },
    });
  });

  it('reuses internal secret authentication before exporting', async () => {
    const response = await app.request(
      '/internal/session/ses_12345678901234567890123456/export',
      {
        headers: {
          'X-Internal-Secret': 'wrong-secret',
          'X-Kilo-User-Id': 'usr_test',
        },
      },
      defaultEnv
    );

    expect(response.status).toBe(401);
    expect(getSessionExport).not.toHaveBeenCalled();
  });

  it('returns an authenticated session export', async () => {
    vi.mocked(getSessionExport).mockResolvedValue(
      new Response('{"ok":true}').body as ReadableStream<Uint8Array>
    );

    const response = await app.request(
      '/internal/session/ses_12345678901234567890123456/export',
      {
        headers: {
          'X-Internal-Secret': 'internal-secret',
          'X-Kilo-User-Id': 'usr_test',
        },
      },
      defaultEnv
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"ok":true}');
    expect(getSessionExport).toHaveBeenCalledWith(
      defaultEnv,
      'ses_12345678901234567890123456',
      'usr_test'
    );
  });
});

describe('public session route', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns 400 for invalid uuid', async () => {
    const res = await app.request('/session/not-a-uuid', {}, defaultEnv);
    expect(res.status).toBe(400);
  });

  it('returns 404 when public_id not found', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    selectResult.mockResolvedValueOnce([]);

    const res = await app.request('/session/11111111-1111-4111-8111-111111111111', {}, defaultEnv);

    expect(res.status).toBe(404);
  });

  it('returns DO snapshot json with content-type', async () => {
    const { db, selectResult } = makeDbFakes();
    vi.mocked(getWorkerDb).mockReturnValue(db as never);
    selectResult.mockResolvedValueOnce([
      {
        session_id: 'ses_12345678901234567890123456',
        kilo_user_id: 'usr_123',
      },
    ]);

    const stub = {
      getAllStream: vi.fn(async () => new Response('{"ok":true}').body!),
    };
    vi.mocked(getSessionIngestDO).mockReturnValue(
      stub as unknown as ReturnType<typeof getSessionIngestDO>
    );

    const res = await app.request('/session/11111111-1111-4111-8111-111111111111', {}, defaultEnv);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(await res.text()).toBe('{"ok":true}');
  });
});
