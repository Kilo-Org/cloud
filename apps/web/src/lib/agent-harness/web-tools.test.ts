import { afterAll, beforeEach, expect, it, jest } from '@jest/globals';
import { TRPCError } from '@trpc/server';
import type { ToolRequest } from '@kilocode/agent-harness/tools';
import type * as Web from './web-tools';

const conversationId = '11111111-1111-4111-8111-111111111111';
const operationId = '22222222-2222-4222-8222-222222222222';
let request: ToolRequest, response: Response, usage: number, balance: number, denied: boolean;
let ledger: Record<string, unknown>[], sent: { url: string; body: unknown }[];
jest.mock('@/lib/config.server', () => ({ EXA_API_KEY: 'provider-secret' }));
jest.mock('@/lib/drizzle', () => ({ readDb: {} }));
jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));
jest.mock('@/lib/exa-usage', () => ({
  getExaMonthlyUsage: async () => ({ usage, freeAllowance: 1000 }),
  getExaFreeAllowanceMicrodollars: () => 1000,
  recordExaUsage: async (entry: Record<string, unknown>) => {
    ledger.push(entry);
  },
}));
jest.mock('@/lib/organizations/organization-usage', () => ({
  getBalanceAndOrgSettings: async () => ({ balance }),
}));
jest.mock('node:dns/promises', () => ({
  resolve4: async (host: string) =>
    host === 'private.example' ? ['8.8.8.8', '10.0.0.1'] : ['8.8.8.8'],
  resolve6: async () => [],
}));
jest.mock('./authorization', () => ({
  harnessInputDigest: JSON.stringify,
  authorizeHarnessCapability: async (token: string, scope: Record<string, unknown>) => {
    if (
      denied ||
      token !== 'grant' ||
      JSON.stringify(scope) !==
        JSON.stringify({
          audience: 'agent-harness:operations',
          conversationId,
          operation: request.name,
          definitionVersion: '1',
          inputDigest: JSON.stringify(request.arguments),
          dispatchId: operationId,
          target: { kind: 'backend' },
        })
    )
      throw new TRPCError({ code: 'FORBIDDEN' });
    return { authority: { organizationId: 'organization' }, ctx: { user: { id: 'oauth/owner' } } };
  },
}));
const { executeHarnessWeb } = jest.requireActual<typeof Web>('./web-tools');
const originalFetch = globalThis.fetch;
const run = (limit = 1024 * 1024) =>
  executeHarnessWeb(
    'grant',
    { conversationId, operationId, request },
    limit,
    new AbortController().signal
  );
beforeEach(() => {
  request = { name: 'web.search', arguments: { query: 'Kilo', limit: 5 } };
  response = Response.json({ results: [], costDollars: { total: 0.002 } });
  usage = 0;
  balance = 1;
  denied = false;
  ledger = [];
  sent = [];
  globalThis.fetch = async (url, init) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return response;
  };
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

it.each([0, 1000])('records one authorized actual charge with monthly usage %s', async monthly => {
  usage = monthly;
  const body = {
    results: [{ url: 'https://example.com', title: 'Kilo', text: 'Page text' }],
    costDollars: { total: 0.002 },
  };
  response = Response.json(body);
  expect(await run()).toEqual({ status: 'succeeded', body, costMicrodollars: 2000 });
  expect(ledger).toEqual([
    {
      userId: 'oauth/owner',
      organizationId: 'organization',
      path: '/search',
      costMicrodollars: 2000,
      chargedToBalance: monthly === 1000,
      freeAllowanceMicrodollars: 1000,
      featureId: 'quick-chat',
      type: undefined,
    },
  ]);
  expect(sent).toEqual([
    {
      url: 'https://api.exa.ai/search',
      body: { query: 'Kilo', numResults: 5, contents: { text: true } },
    },
  ]);
});
it('blocks revoked authority and exhausted credit before provider dispatch', async () => {
  denied = true;
  expect(await run()).toMatchObject({
    status: 'failed',
    error: { code: 'access_revoked', retryable: false },
  });
  denied = false;
  usage = 1000;
  balance = 0;
  expect(await run()).toMatchObject({
    status: 'failed',
    error: { code: 'limit_exceeded', retryable: false },
    costMicrodollars: 0,
  });
  expect(sent).toEqual([]);
  expect(ledger).toEqual([]);
});
it.each([
  'http://example.com',
  'file:///etc/passwd',
  'https://localhost',
  'https://127.0.0.1',
  'https://[::1]',
  'https://private.example',
  'https://user:password@example.com',
  'https://example.com/#fragment',
])('blocks unsafe retrieval: %s', async url => {
  request = { name: 'web.retrieve', arguments: { url } };
  expect(await run()).toMatchObject({
    status: 'failed',
    error: { code: 'invalid_input', retryable: false },
  });
  expect(sent).toEqual([]);
});
it('uses only contents for public retrieval and cancels overflow before parsing or billing', async () => {
  request = { name: 'web.retrieve', arguments: { url: 'https://EXAMPLE.COM/page' } };
  let cancelled = false;
  response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(50));
        controller.enqueue(new Uint8Array(50));
      },
      cancel() {
        cancelled = true;
      },
    }),
    { headers: { 'content-type': 'application/json' } }
  );
  expect(await run(99)).toMatchObject({
    status: 'failed',
    error: { code: 'limit_exceeded', retryable: false },
    costMicrodollars: null,
  });
  expect(cancelled).toBe(true);
  expect(ledger).toEqual([]);
  expect(sent).toEqual([
    { url: 'https://api.exa.ai/contents', body: { ids: ['https://example.com/page'], text: true } },
  ]);
});
it.each([
  [429, 'application/json', '{}', 'unavailable_tool', true],
  [403, 'application/json', '{}', 'unavailable_tool', false],
  [200, 'text/html', '<html/>', 'invalid_output', false],
  [200, 'application/json', '{', 'invalid_output', false],
] as const)(
  'keeps provider failure %s %s explicit',
  async (status, contentType, body, code, retryable) => {
    response = new Response(body, { status, headers: { 'content-type': contentType } });
    expect(await run()).toMatchObject({
      status: 'failed',
      error: { code, retryable },
      costMicrodollars: null,
    });
    expect(ledger).toEqual([]);
  }
);
it.each([
  { conversationId: operationId },
  { operationId: conversationId },
  { request: { name: 'web.search', arguments: { query: 'changed', limit: 5 } } },
  { request: { name: 'web.retrieve', arguments: { url: 'https://example.com' } } },
])('rejects changed capability input %# before dispatch', async change => {
  const result = await executeHarnessWeb(
    'grant',
    { conversationId, operationId, request, ...change },
    1024,
    new AbortController().signal
  );
  expect(result).toMatchObject({
    status: 'failed',
    error: { code: 'access_revoked', retryable: false },
    costMicrodollars: 0,
  });
  expect(sent).toEqual([]);
  expect(ledger).toEqual([]);
});
it.each(['web.search', 'web.retrieve'] as const)(
  'preserves empty provider data for %s',
  async name => {
    request = name === 'web.search' ? request : { name, arguments: { url: 'https://example.com' } };
    response = Response.json({ results: [] });
    expect(await run()).toEqual({
      status: 'succeeded',
      body: { results: [] },
      costMicrodollars: null,
    });
  }
);
it.each(['before', 'during', 'lost'])('reports cancellation or response loss: %s', async phase => {
  const controller = new AbortController();
  let dispatched = false;
  globalThis.fetch = async (_url, init) => {
    dispatched = true;
    if (phase === 'during') controller.abort();
    init?.signal?.throwIfAborted();
    throw new TypeError('Response lost');
  };
  if (phase === 'before') controller.abort();
  const result = await executeHarnessWeb(
    'grant',
    { conversationId, operationId, request },
    1024,
    controller.signal
  );
  expect(result).toMatchObject({
    status: 'failed',
    error: {
      code: phase === 'lost' ? 'unavailable_tool' : 'cancelled',
      retryable: phase === 'lost',
    },
    costMicrodollars: phase === 'before' ? 0 : null,
  });
  expect(dispatched).toBe(phase !== 'before');
  expect(ledger).toEqual([]);
});
it('keeps unsupported content terminal when cancellation fails', async () => {
  response = new Response(
    new ReadableStream({
      cancel() {
        throw new Error('Cleanup failed');
      },
    }),
    { headers: { 'content-type': 'text/html' } }
  );
  expect(await run()).toMatchObject({
    status: 'failed',
    error: { code: 'invalid_output', retryable: false },
    costMicrodollars: null,
  });
  expect(ledger).toEqual([]);
});
it.each([undefined, 0, -1, '0.002'])(
  'does not invent or bill unknown/invalid cost %s',
  async total => {
    response = Response.json({ results: [], costDollars: { total } });
    expect(await run()).toMatchObject({
      status: total === undefined || total === 0 ? 'succeeded' : 'failed',
      costMicrodollars: total === 0 ? 0 : null,
    });
    expect(ledger).toEqual([]);
  }
);
