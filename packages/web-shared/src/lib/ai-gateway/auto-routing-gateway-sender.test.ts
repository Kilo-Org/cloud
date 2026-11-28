// The AI Gateway's two auto-routing edges, `POST /decide` and the benchmark routing-table reads,
// through the real clients and the real token client: only the network (the STS mint and the Worker
// call) and the Vercel identity are faked. Do not import `jest` from '@jest/globals': the SWC
// transform hoists these `jest.mock` calls only with the global `jest`.
const mockSwitches: Record<string, string | undefined> = {};
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  INTERNAL_API_SECRET: 'legacy-internal-secret',
  AUTO_ROUTING_WORKER_URL: 'https://auto-routing.kiloapps.io',
  AUTO_ROUTING_BENCHMARK_WORKER_URL: 'https://auto-routing-benchmark.kiloapps.io',
  // Read at each call, so a test sets a switch through `mockSwitches`.
  get AUTO_ROUTING_DECIDE_SENDER_AUTH() {
    return mockSwitches.AUTO_ROUTING_DECIDE_SENDER_AUTH;
  },
  get GATEWAY_ROUTING_TABLES_SENDER_AUTH() {
    return mockSwitches.GATEWAY_ROUTING_TABLES_SENDER_AUTH;
  },
  get WEB_ROUTING_TABLES_SENDER_AUTH() {
    return mockSwitches.WEB_ROUTING_TABLES_SENDER_AUTH;
  },
}));
jest.mock('@vercel/functions', () => ({
  getCache: jest.fn(() => ({})),
  waitUntil: jest.fn(),
}));
jest.mock('@kilocode/service-token-client/vercel', () => ({
  vercelIdentity: jest.fn(() => async () => 'exchanged-identity-token'),
}));

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import {
  STS_AUTO_ROUTING_BENCHMARK_ROUTING_TABLES_READ,
  STS_AUTO_ROUTING_DECIDE,
  STS_ISSUERS,
} from '@kilocode/sts-contracts';
import type { EfficientDecisionParams } from './auto-routing-decision';

const PRODUCTION = { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' };
const MINT_URL = `${STS_ISSUERS.production}/v1/token`;
const nativeFetch = globalThis.fetch;
// Every client here calls `fetch` with a string URL.
const fetchMock = jest.fn<Promise<Response>, [string, RequestInit?]>();
let mintAnswer: 'issue' | 'deny' = 'issue';
let minted = 0;

function mintResponse(init: RequestInit | undefined): Response {
  const body = JSON.parse(init?.body as string) as {
    tokens: { audience: string; scope: string }[];
  };
  const [request] = body.tokens;
  if (request === undefined) throw new Error('mint without a token request');
  if (mintAnswer === 'deny') {
    return Response.json({
      status: 'ok',
      tokens: [{ status: 'denied', ...request, reason: 'unknown_scope' }],
    });
  }
  minted += 1;
  return Response.json({
    status: 'ok',
    tokens: [
      {
        status: 'issued',
        ...request,
        token: `minted-token-${minted}`,
        jti: `jti-${minted}`,
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      },
    ],
  });
}

const decision = {
  model: 'anthropic/claude-haiku-4',
  taskType: 'implementation',
  subtaskType: 'feature_development',
  source: 'benchmark',
  tableVersion: 'v1',
  sticky: false,
};

function workerResponse(url: string): Response {
  return url.endsWith('/decide')
    ? Response.json({ cost: 0, decision, classifierResult: null })
    : Response.json({ table: null, publishedAt: null });
}

const params: EfficientDecisionParams = {
  apiKind: 'chat_completions',
  body: { model: 'kilo-auto/efficient', messages: [{ role: 'user', content: 'Fix the bug.' }] },
  requestedModel: 'kilo-auto/efficient',
  providerHints: { provider: null, providerOptions: null },
  bodyBytes: 64,
  userId: 'user-1',
  organizationId: null,
  sessionId: null,
  machineId: null,
  clientRequestId: null,
  mode: null,
  userAgent: null,
};

type GatewayClients = { decide: () => Promise<unknown>; routingTable: () => Promise<unknown> };

/** Fresh modules, so each test starts with a cold token client and installs its own sender. */
async function loadGateway(): Promise<GatewayClients> {
  jest.resetModules();
  const sender = await import('./auto-routing-sender');
  const gateway = await import('./auto-routing-gateway-sender');
  sender.installAutoRoutingSender(gateway.createGatewayAutoRoutingSender(PRODUCTION));
  const { fetchEfficientAutoDecision } = await import('./auto-routing-decision');
  const { getBenchmarkRoutingTable } = await import('./auto-routing-benchmark-admin-client');
  return {
    decide: () => fetchEfficientAutoDecision(params, { onError: () => {} }),
    routingTable: () => getBenchmarkRoutingTable('efficient'),
  };
}

type Edge = {
  name: string;
  variable: string;
  request: { audience: string; scope: string };
  workerUrl: string;
  call: (clients: GatewayClients) => Promise<unknown>;
};

const EDGES: Edge[] = [
  {
    name: 'POST /decide',
    variable: 'AUTO_ROUTING_DECIDE_SENDER_AUTH',
    request: STS_AUTO_ROUTING_DECIDE,
    workerUrl: 'https://auto-routing.kiloapps.io/decide',
    call: clients => clients.decide(),
  },
  {
    name: 'GET /admin/routing-table',
    variable: 'GATEWAY_ROUTING_TABLES_SENDER_AUTH',
    request: STS_AUTO_ROUTING_BENCHMARK_ROUTING_TABLES_READ,
    workerUrl: 'https://auto-routing-benchmark.kiloapps.io/admin/routing-table?router=efficient',
    call: clients => clients.routingTable(),
  },
];

function mintCalls() {
  return fetchMock.mock.calls.filter(([url]) => url === MINT_URL);
}

function workerCalls() {
  return fetchMock.mock.calls.filter(([url]) => url !== MINT_URL);
}

function sentAuthorization(index = 0): string | null {
  return new Headers(workerCalls()[index]?.[1]?.headers).get('authorization');
}

beforeEach(() => {
  for (const key of Object.keys(mockSwitches)) delete mockSwitches[key];
  mintAnswer = 'issue';
  minted = 0;
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (input, init) =>
    input === MINT_URL ? mintResponse(init) : workerResponse(input)
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  process.env.KILO_STS_WORKLOAD = 'ai-gateway';
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = nativeFetch;
  globalThis.__kilocodeAutoRoutingSender = undefined;
  delete process.env.KILO_STS_WORKLOAD;
  jest.restoreAllMocks();
});

describe.each(EDGES)('the gateway sender on $name', edge => {
  it('sends the internal secret and mints nothing while the switch is unset', async () => {
    const clients = await loadGateway();
    await edge.call(clients);

    expect(mintCalls()).toHaveLength(0);
    expect(workerCalls()).toHaveLength(1);
    expect(workerCalls()[0]?.[0]).toBe(edge.workerUrl);
    expect(sentAuthorization()).toBe('Bearer legacy-internal-secret');
  });

  it('sends exactly one STS token of the route scope, and no secret, under sts', async () => {
    mockSwitches[edge.variable] = 'sts';
    const clients = await loadGateway();
    await edge.call(clients);

    expect(mintCalls()).toHaveLength(1);
    expect(JSON.parse(mintCalls()[0]?.[1]?.body as string)).toEqual({ tokens: [edge.request] });
    expect(workerCalls()).toHaveLength(1);
    expect(sentAuthorization()).toBe('Bearer minted-token-1');
    expect(workerCalls()[0]?.[1]?.redirect).toBe('error');
  });

  it('holds the token: two calls, one mint', async () => {
    mockSwitches[edge.variable] = 'sts';
    const clients = await loadGateway();
    await edge.call(clients);
    await edge.call(clients);

    expect(mintCalls()).toHaveLength(1);
    expect(workerCalls()).toHaveLength(2);
    expect(sentAuthorization(1)).toBe('Bearer minted-token-1');
  });

  it.each(['STS', 'dual', 'true'])('sends nothing for the switch value %j', async value => {
    mockSwitches[edge.variable] = value;
    const clients = await loadGateway();
    await edge.call(clients).catch(() => {});

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing, and never the secret, when STS refuses the token', async () => {
    mockSwitches[edge.variable] = 'sts';
    mintAnswer = 'deny';
    const clients = await loadGateway();
    await edge.call(clients).catch(() => {});

    expect(mintCalls()).toHaveLength(1);
    expect(workerCalls()).toHaveLength(0);
  });

  it('sends nothing under sts outside the ai-gateway build', async () => {
    mockSwitches[edge.variable] = 'sts';
    delete process.env.KILO_STS_WORKLOAD;
    const clients = await loadGateway();
    await edge.call(clients).catch(() => {});

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the gateway sender', () => {
  it('never reads the web routing-table switch', async () => {
    mockSwitches.WEB_ROUTING_TABLES_SENDER_AUTH = 'sts';
    const clients = await loadGateway();
    await clients.routingTable();

    expect(mintCalls()).toHaveLength(0);
    expect(sentAuthorization()).toBe('Bearer legacy-internal-secret');
  });

  it('refuses sts on staging', async () => {
    mockSwitches.AUTO_ROUTING_DECIDE_SENDER_AUTH = 'sts';
    jest.resetModules();
    const sender = await import('./auto-routing-sender');
    const gateway = await import('./auto-routing-gateway-sender');
    sender.installAutoRoutingSender(
      gateway.createGatewayAutoRoutingSender({
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'staging',
      })
    );
    const { fetchEfficientAutoDecision } = await import('./auto-routing-decision');

    await expect(fetchEfficientAutoDecision(params, { onError: () => {} })).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
