import { afterAll, beforeEach, expect, it, jest } from '@jest/globals';
import type * as Route from '@/app/api/exa/[...path]/route';
import type { User } from '@kilocode/db/schema';
import type * as Provider from './exa-provider';

let response: Response, upstreamRequest: Request, usage: number, balance: number;
let ledger: Record<string, unknown>[],
  sent: { url: string; body: unknown }[],
  after: (() => Promise<void>)[];
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
jest.mock('@/lib/user/server', () => ({
  getUserFromAuth: async () => ({
    user: { id: 'oauth/owner' },
    organizationId: 'organization',
    authFailedResponse: null,
  }),
}));
jest.mock('@/lib/ai-gateway/llm-proxy-helpers', () => ({
  wrapInSafeNextResponse: (value: Response) => value,
}));
jest.mock('next/server', () => ({
  ...jest.requireActual<object>('next/server'),
  after: (callback: () => Promise<void>) => {
    after.push(callback);
  },
}));
const { POST } = jest.requireActual<typeof Route>('@/app/api/exa/[...path]/route');
const { prepareExaRequest, extractExaCostMicrodollars } =
  jest.requireActual<typeof Provider>('./exa-provider');
const originalFetch = globalThis.fetch;
beforeEach(() => {
  response = Response.json({ results: [], costDollars: { total: 0.002 } });
  usage = 0;
  balance = 1;
  ledger = [];
  sent = [];
  after = [];
  globalThis.fetch = async (url, init) => {
    upstreamRequest = new Request(String(url), init);
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    return response;
  };
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});

it.each(['/search', '/contents', '/findSimilar', '/answer', '/context'])(
  'preserves legacy %s responses and delayed billing',
  async path => {
    const result = await POST(
      new Request(`https://kilo.example/api/exa${path}`, {
        method: 'POST',
        body: JSON.stringify({ query: 'old', stream: true }),
      }) as never
    );
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ results: [], costDollars: { total: 0.002 } });
    expect(sent[0]).toEqual({ url: `https://api.exa.ai${path}`, body: { query: 'old' } });
    expect(upstreamRequest.redirect).toBe('follow');
    expect(upstreamRequest.headers.get('accept')).toBeNull();
    expect(ledger).toEqual([]);
    for (const callback of after) await callback();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ path, costMicrodollars: 2000, chargedToBalance: false });
  }
);

it.each([
  [0, false],
  [1000, true],
] as const)(
  'shares actual-cost billing with JSON-only callers at usage %s',
  async (monthly, paid) => {
    usage = monthly;
    const provider = await prepareExaRequest({ id: 'oauth/owner' } as User, 'organization');
    if (provider instanceof Response) throw new Error(`Unexpected status: ${provider.status}`);
    const result = await provider.send(
      '/contents',
      { ids: ['https://example.com'] },
      new AbortController().signal,
      true
    );
    expect(upstreamRequest.redirect).toBe('error');
    expect(upstreamRequest.headers.get('accept')).toBe('application/json');
    expect(ledger).toEqual([]);
    await provider.record(
      '/contents',
      extractExaCostMicrodollars(await result.json()),
      'quick-chat'
    );
    expect(ledger).toEqual([
      {
        userId: 'oauth/owner',
        organizationId: 'organization',
        path: '/contents',
        costMicrodollars: 2000,
        chargedToBalance: paid,
        freeAllowanceMicrodollars: 1000,
        featureId: 'quick-chat',
        type: undefined,
      },
    ]);
  }
);

it.each([undefined, 0])('preserves cost %s without inventing a charge', async total => {
  const provider = await prepareExaRequest({ id: 'oauth/owner' } as User, 'organization');
  if (provider instanceof Response) throw new Error(`Unexpected status: ${provider.status}`);
  const cost = extractExaCostMicrodollars({ costDollars: { total } });
  expect(cost).toBe(total);
  await provider.record('/search', cost);
  expect(ledger).toEqual([]);
});

it.each([429, 503])('preserves retryable provider status %s without billing', async status => {
  response = Response.json({ error: 'Retry later', costDollars: { total: 0.002 } }, { status });
  const result = await POST(
    new Request('https://kilo.example/api/exa/search', { method: 'POST', body: '{}' }) as never
  );
  expect(result.status).toBe(status);
  expect(await result.json()).toEqual({ error: 'Retry later', costDollars: { total: 0.002 } });
  for (const callback of after) await callback();
  expect(ledger).toEqual([]);
});
