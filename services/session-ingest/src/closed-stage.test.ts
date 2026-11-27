import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { unstable_readConfig } from 'wrangler';

vi.mock('cloudflare:workers', () => ({
  DurableObject: class DurableObject {
    constructor(_state: unknown, _env: unknown) {}
  },
  WorkerEntrypoint: class WorkerEntrypoint {
    env: unknown;
    ctx: ExecutionContext;

    constructor(ctx: ExecutionContext, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('@kilocode/db/client', () => ({
  getWorkerDb: vi.fn(() => {
    throw new Error('database client reached');
  }),
}));

// No Durable Object is constructed here; a constructor that ran would fail at once.
vi.mock('drizzle-orm/durable-sqlite', () => ({
  drizzle: vi.fn(() => {
    throw new Error('durable object storage reached');
  }),
}));
vi.mock('drizzle-orm/durable-sqlite/migrator', () => ({ migrate: vi.fn() }));

import { getWorkerDb } from '@kilocode/db/client';
import { app } from './app';
import { SessionIngestRPC } from './session-ingest-rpc';
import type { Env } from './env';

// The closed staging Worker sees exactly the bindings and vars of its rendered
// config: its own Durable Object namespaces and three vars, nothing else.
const staging = unstable_readConfig({
  config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href),
  env: 'staging',
});

const SESSION_ID = 'ses_12345678901234567890123456';
const KILO_USER_ID = 'usr_closed_stage';

let durableObjectCalls: string[];
let fetchSpy: MockInstance<typeof fetch>;

/** A namespace that records and refuses every use, so a test sees any Durable Object access. */
function refusingNamespace(binding: string): unknown {
  return new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'then') return undefined;
        return () => {
          durableObjectCalls.push(`${binding}.${String(property)}`);
          throw new Error('durable object reached');
        };
      },
    }
  );
}

function closedEnv(): Env {
  const env: Record<string, unknown> = { ...staging.vars };
  for (const { name } of staging.durable_objects.bindings) {
    env[name] = refusingNamespace(name);
  }
  return env as unknown as Env;
}

const executionCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

beforeEach(() => {
  durableObjectCalls = [];
  vi.mocked(getWorkerDb).mockClear();
  fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
    throw new Error('network reached');
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  expect(durableObjectCalls).toEqual([]);
  expect(getWorkerDb).not.toHaveBeenCalled();
  expect(fetchSpy).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe('closed staging session-ingest', () => {
  it('binds only the live staging Durable Objects, without the ticket namespace', () => {
    expect(Object.keys(closedEnv()).sort()).toEqual(
      [
        'DIRECT_INGEST_MAX_BYTES',
        'DIRECT_INGEST_PERCENT',
        'SESSION_ACCESS_CACHE_DO',
        'SESSION_INGEST_DO',
        'SESSION_SHARE_TOKEN_MIN_IAT',
        'USER_CONNECTION_DO',
      ].sort()
    );
  });

  const bearer = { Authorization: 'Bearer closed-stage-token' };
  const internal = { 'X-Internal-Secret': 'closed-stage-secret', 'X-Kilo-User-Id': KILO_USER_ID };

  it.each<{ method: string; path: string; headers: Record<string, string>; status: number }>([
    { method: 'GET', path: '/api/sessions/active', headers: {}, status: 401 },
    { method: 'GET', path: '/api/sessions/active', headers: bearer, status: 503 },
    { method: 'POST', path: '/api/session', headers: bearer, status: 503 },
    { method: 'DELETE', path: `/api/session/${SESSION_ID}`, headers: bearer, status: 503 },
    {
      method: 'GET',
      path: '/api/user/cli?token=closed-stage-token',
      headers: { Upgrade: 'websocket' },
      status: 503,
    },
    // The ticket routes: redemption reads no Authorization header and resolves to no
    // namespace, so a well-formed or malformed ticket gets 401; the mint is behind auth.
    {
      method: 'GET',
      path: `/api/user/web?ticket=${'a'.repeat(64)}.00000000-0000-4000-8000-000000000000`,
      headers: { Upgrade: 'websocket' },
      status: 401,
    },
    {
      method: 'GET',
      path: '/api/user/web?ticket=malformed',
      headers: { Upgrade: 'websocket' },
      status: 401,
    },
    { method: 'POST', path: '/api/user/web-ticket', headers: bearer, status: 503 },
    {
      method: 'GET',
      path: `/internal/cloud-agent/v1/sessions/${SESSION_ID}`,
      headers: { ...bearer, ...internal },
      status: 503,
    },
    {
      method: 'POST',
      path: '/internal/session-access/invalidate',
      headers: internal,
      status: 503,
    },
    { method: 'GET', path: `/internal/session/${SESSION_ID}/export`, headers: {}, status: 503 },
    {
      method: 'GET',
      path: `/internal/session/${SESSION_ID}/export`,
      headers: internal,
      status: 503,
    },
    { method: 'GET', path: '/session/closed-stage-share-token', headers: {}, status: 500 },
    { method: 'GET', path: '/session/closed-stage-share-token/metadata', headers: {}, status: 500 },
  ])('$method $path refuses with $status before any external access', async request => {
    const response = await app.fetch(
      new Request(`https://session-ingest-staging.invalid${request.path}`, {
        method: request.method,
        headers: request.headers,
      }),
      closedEnv(),
      executionCtx
    );
    expect(response.status).toBe(request.status);
  });

  it('rejects RPC reads and writes before any external access', async () => {
    const rpc = new SessionIngestRPC(executionCtx, closedEnv());

    await expect(rpc.listCloudAgentRootSessions({ kiloUserId: KILO_USER_ID })).rejects.toThrow(
      TypeError
    );
    await expect(
      rpc.getSessionMessages({ kiloUserId: KILO_USER_ID, kiloSessionId: SESSION_ID })
    ).rejects.toThrow(TypeError);
    await expect(
      rpc.deleteSessionForCloudAgent({ kiloUserId: KILO_USER_ID, sessionId: SESSION_ID })
    ).rejects.toThrow(TypeError);
    await expect(
      rpc.completeCloudAgentWorktreeDeletion({
        kiloUserId: KILO_USER_ID,
        worktreeId: 'worktree_00000000-0000-4000-8000-000000000000',
      })
    ).rejects.toThrow(TypeError);
  });
});
