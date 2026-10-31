import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { restoreKilo2History } from './kilo2-history.js';
import type { Kilo2Api } from './kilo2-api.js';

const SESSION_ID = `ses_${'a'.repeat(26)}`;
const CLOUD_SESSION_ID = 'workspace_00000000-0000-4000-8000-000000000000';
const HISTORY_PATH = '/api/runtime-credential-proxy/history/page';

type FetchCall = { url: URL; method: string; authorization: string | null; body: unknown };

function fakeApi() {
  const calls: string[] = [];
  const api: Kilo2Api = {
    async request(path, options) {
      calls.push(`${options?.method ?? 'GET'} ${path.split('?')[0]}`);
      if (path.startsWith('/api/location')) return { project: { id: 'project-1' } };
      return undefined;
    },
    async data() {
      throw new Error('unused api.data');
    },
  };
  return { api, calls };
}

function page(body: Record<string, unknown>): Response {
  return Response.json(body);
}

function input(overrides: { env?: Record<string, string> } = {}) {
  const restored: boolean[] = [];
  return {
    restored,
    value: {
      sessionId: SESSION_ID,
      cloudSessionId: CLOUD_SESSION_ID,
      directory: '/workspace/app',
      env: overrides.env ?? {
        KILO_AUTH_CONTENT: JSON.stringify({ kilo: { type: 'api', key: 'runtime-handle' } }),
      },
      restoreFiles: false,
      onRestore: () => restored.push(true),
    },
  };
}

const previousControlUrl = process.env.SANDBOX_CONTROL_URL;
let fetchCalls: FetchCall[];
let fetchResponder: (call: FetchCall) => Response;
const previousFetch = globalThis.fetch;

beforeEach(() => {
  process.env.SANDBOX_CONTROL_URL = 'http://127.0.0.1:1';
  fetchCalls = [];
  fetchResponder = () =>
    page({
      kind: 'success',
      source: { version: 'v1' },
      info: { id: SESSION_ID },
      messages: [],
      nextCursor: null,
      omittedItemCount: 0,
    });
  globalThis.fetch = (async (resource: string | URL | Request, init?: RequestInit) => {
    const call = {
      url: new URL(resource instanceof Request ? resource.url : resource.toString()),
      method: init?.method ?? (resource instanceof Request ? resource.method : 'GET'),
      authorization: new Headers(
        init?.headers ?? (resource instanceof Request ? resource.headers : undefined)
      ).get('authorization'),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    fetchCalls.push(call);
    return fetchResponder(call);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = previousFetch;
  if (previousControlUrl === undefined) delete process.env.SANDBOX_CONTROL_URL;
  else process.env.SANDBOX_CONTROL_URL = previousControlUrl;
});

describe('restoreKilo2History runtime credential route', () => {
  it('reads the narrow runtime history route with the grant credential and no cloud selector', async () => {
    const { api, calls } = fakeApi();
    const target = input();
    const outcome = await restoreKilo2History(api, target.value);

    expect(outcome).toBe(false);
    expect(calls).toEqual([]);
    expect(target.restored).toEqual([]);
    expect(fetchCalls).toHaveLength(1);
    const [call] = fetchCalls;
    expect(call?.url.origin + call?.url.pathname).toBe(`http://127.0.0.1:1${HISTORY_PATH}`);
    expect(call?.method).toBe('POST');
    expect(call?.authorization).toBe('Bearer runtime-handle');
    expect(call?.body).toEqual({ limit: 100, rootNativeId: SESSION_ID });
    expect(JSON.stringify(call?.body)).not.toContain(CLOUD_SESSION_ID);
  });

  it('imports a v2 history page and reports the restore', async () => {
    const { api, calls } = fakeApi();
    const target = input();
    fetchResponder = () =>
      page({
        kind: 'success',
        source: { version: 'v2', session: { id: SESSION_ID } },
        info: { id: SESSION_ID },
        messages: [
          {
            message: {
              id: `msg_${'b'.repeat(26)}`,
              type: 'user',
              time: { created: 5 },
              text: 'remember amber',
            },
          },
        ],
        nextCursor: null,
        omittedItemCount: 0,
      });

    expect(await restoreKilo2History(api, target.value)).toBe(true);
    expect(target.restored).toEqual([true]);
    expect(calls).toEqual(['GET /api/location', 'POST /api/experimental/session/import']);
  });

  it('fails closed on a non-OK history response', () => {
    const { api, calls } = fakeApi();
    const target = input();
    fetchResponder = () => new Response('Unauthorized', { status: 401 });

    expect(restoreKilo2History(api, target.value)).rejects.toThrow(
      'Local Cloud history read failed: HTTP 401'
    );
    expect(calls).toEqual([]);
  });

  it('does not read history without a route credential', () => {
    const { api } = fakeApi();
    const target = input({ env: { KILO_AUTH_CONTENT: '{"kilo":{"type":"api"}}' } });
    expect(restoreKilo2History(api, target.value)).rejects.toThrow(
      'Kilo v2 history recovery requires the current route credential'
    );
    expect(fetchCalls).toEqual([]);
  });

  it('rejects a page that belongs to another native session', () => {
    const { api } = fakeApi();
    const target = input();
    fetchResponder = () =>
      page({
        kind: 'success',
        source: { version: 'v2', session: { id: `ses_${'c'.repeat(26)}` } },
        info: { id: `ses_${'c'.repeat(26)}` },
        messages: [],
        nextCursor: null,
        omittedItemCount: 0,
      });

    expect(restoreKilo2History(api, target.value)).rejects.toThrow(
      'Local Cloud history belongs to another native session'
    );
  });
});
