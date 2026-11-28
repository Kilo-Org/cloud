// The web app's auto-routing edges through the real shared clients, `service-sender-auth.ts` and
// the real token client: only the network (the STS mint and the Worker call) and the Vercel
// identity are faked. Do not import `jest` from '@jest/globals': the SWC transform hoists these
// `jest.mock` calls only with the global `jest`.
const mockSwitches: Record<string, string | undefined> = {};
const mockWorkerUrl = { value: 'https://auto-routing.kiloapps.io' };
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  INTERNAL_API_SECRET: 'legacy-internal-secret',
  get AUTO_ROUTING_WORKER_URL() {
    return mockWorkerUrl.value;
  },
  AUTO_ROUTING_BENCHMARK_WORKER_URL: 'https://auto-routing-benchmark.kiloapps.io',
  // Read at each call, so a test sets a switch through `mockSwitches`.
  get AUTO_ROUTING_ADMIN_SENDER_AUTH() {
    return mockSwitches.AUTO_ROUTING_ADMIN_SENDER_AUTH;
  },
  get AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH() {
    return mockSwitches.AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH;
  },
  get WEB_ROUTING_TABLES_SENDER_AUTH() {
    return mockSwitches.WEB_ROUTING_TABLES_SENDER_AUTH;
  },
  get GATEWAY_ROUTING_TABLES_SENDER_AUTH() {
    return mockSwitches.GATEWAY_ROUTING_TABLES_SENDER_AUTH;
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
  STS_AUTO_ROUTING_ADMIN_READ,
  STS_AUTO_ROUTING_ADMIN_WRITE,
  STS_AUTO_ROUTING_BENCHMARK_ADMIN_READ,
  STS_AUTO_ROUTING_BENCHMARK_ADMIN_WRITE,
  STS_AUTO_ROUTING_BENCHMARK_ROUTING_TABLES_READ,
  STS_ISSUERS,
} from '@kilocode/sts-contracts';

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

type WebClients = {
  autoRoutingRead: () => Promise<unknown>;
  autoRoutingWrite: () => Promise<unknown>;
  benchmarkRead: () => Promise<unknown>;
  benchmarkWrite: () => Promise<unknown>;
  routingTable: () => Promise<unknown>;
};

/** Fresh modules, so each test starts with a cold token client and installs its own sender. */
async function loadWeb(): Promise<WebClients> {
  jest.resetModules();
  const { installAutoRoutingSender } =
    await import('@kilocode/web-shared/lib/ai-gateway/auto-routing-sender');
  const { createWebAutoRoutingSender } = await import('./auto-routing-sender');
  installAutoRoutingSender(createWebAutoRoutingSender(PRODUCTION));
  const admin = await import('@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client');
  const benchmark =
    await import('@kilocode/web-shared/lib/ai-gateway/auto-routing-benchmark-admin-client');
  return {
    autoRoutingRead: () => admin.getAutoRoutingClassifierModel(),
    autoRoutingWrite: () => admin.updateAutoRoutingClassifierModel(null),
    benchmarkRead: () => benchmark.getBenchmarkConfig('efficient'),
    benchmarkWrite: () => benchmark.cancelBenchmarkRun('run-1', 'efficient'),
    routingTable: () => benchmark.getBenchmarkRoutingTable('efficient'),
  };
}

type Edge = {
  name: string;
  variable: string;
  request: { audience: string; scope: string };
  workerUrl: string;
  call: (clients: WebClients) => Promise<unknown>;
};

const EDGES: Edge[] = [
  {
    name: 'auto-routing GET /admin/classifier-model',
    variable: 'AUTO_ROUTING_ADMIN_SENDER_AUTH',
    request: STS_AUTO_ROUTING_ADMIN_READ,
    workerUrl: 'https://auto-routing.kiloapps.io/admin/classifier-model',
    call: clients => clients.autoRoutingRead(),
  },
  {
    name: 'auto-routing PUT /admin/classifier-model',
    variable: 'AUTO_ROUTING_ADMIN_SENDER_AUTH',
    request: STS_AUTO_ROUTING_ADMIN_WRITE,
    workerUrl: 'https://auto-routing.kiloapps.io/admin/classifier-model',
    call: clients => clients.autoRoutingWrite(),
  },
  {
    name: 'benchmark GET /admin/config',
    variable: 'AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH',
    request: STS_AUTO_ROUTING_BENCHMARK_ADMIN_READ,
    workerUrl: 'https://auto-routing-benchmark.kiloapps.io/admin/config?router=efficient',
    call: clients => clients.benchmarkRead(),
  },
  {
    name: 'benchmark POST /admin/runs/:runId/cancel',
    variable: 'AUTO_ROUTING_BENCHMARK_ADMIN_SENDER_AUTH',
    request: STS_AUTO_ROUTING_BENCHMARK_ADMIN_WRITE,
    workerUrl:
      'https://auto-routing-benchmark.kiloapps.io/admin/runs/run-1/cancel?router=efficient',
    call: clients => clients.benchmarkWrite(),
  },
  {
    name: 'benchmark GET /admin/routing-table',
    variable: 'WEB_ROUTING_TABLES_SENDER_AUTH',
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
  // Every Worker call answers 404, so the clients return without parsing a response body.
  fetchMock.mockImplementation(async (input, init) =>
    input === MINT_URL ? mintResponse(init) : Response.json({ error: 'x' }, { status: 404 })
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = nativeFetch;
  globalThis.__kilocodeAutoRoutingSender = undefined;
  jest.restoreAllMocks();
});

describe.each(EDGES)('the web sender on $name', edge => {
  it('sends the internal secret and mints nothing while the switch is unset', async () => {
    const clients = await loadWeb();
    await edge.call(clients);

    expect(mintCalls()).toHaveLength(0);
    expect(workerCalls()).toHaveLength(1);
    expect(workerCalls()[0]?.[0]).toBe(edge.workerUrl);
    expect(sentAuthorization()).toBe('Bearer legacy-internal-secret');
  });

  it('sends exactly one STS token of the route scope, and no secret, under sts', async () => {
    mockSwitches[edge.variable] = 'sts';
    const clients = await loadWeb();
    await edge.call(clients);

    expect(mintCalls()).toHaveLength(1);
    expect(JSON.parse(mintCalls()[0]?.[1]?.body as string)).toEqual({ tokens: [edge.request] });
    expect(workerCalls()).toHaveLength(1);
    expect(workerCalls()[0]?.[0]).toBe(edge.workerUrl);
    expect(sentAuthorization()).toBe('Bearer minted-token-1');
    expect(workerCalls()[0]?.[1]?.redirect).toBe('error');
  });

  it('holds the token: two calls, one mint', async () => {
    mockSwitches[edge.variable] = 'sts';
    const clients = await loadWeb();
    await edge.call(clients);
    await edge.call(clients);

    expect(mintCalls()).toHaveLength(1);
    expect(workerCalls()).toHaveLength(2);
    expect(sentAuthorization(1)).toBe('Bearer minted-token-1');
  });

  it.each(['STS', 'dual', 'true'])('sends nothing for the switch value %j', async value => {
    mockSwitches[edge.variable] = value;
    const clients = await loadWeb();

    await expect(edge.call(clients)).resolves.toMatchObject({ status: 500 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends nothing, and never the secret, when STS refuses the token', async () => {
    mockSwitches[edge.variable] = 'sts';
    mintAnswer = 'deny';
    const clients = await loadWeb();

    await expect(edge.call(clients)).resolves.toMatchObject({ status: 503 });
    expect(mintCalls()).toHaveLength(1);
    expect(workerCalls()).toHaveLength(0);
  });
});

describe('the web sender', () => {
  it('never reads the gateway routing-table switch', async () => {
    mockSwitches.GATEWAY_ROUTING_TABLES_SENDER_AUTH = 'sts';
    const clients = await loadWeb();
    await clients.routingTable();

    expect(mintCalls()).toHaveLength(0);
    expect(sentAuthorization()).toBe('Bearer legacy-internal-secret');
  });

  it('refuses sts on staging', async () => {
    mockSwitches.AUTO_ROUTING_ADMIN_SENDER_AUTH = 'sts';
    jest.resetModules();
    const { installAutoRoutingSender } =
      await import('@kilocode/web-shared/lib/ai-gateway/auto-routing-sender');
    const { createWebAutoRoutingSender } = await import('./auto-routing-sender');
    installAutoRoutingSender(
      createWebAutoRoutingSender({ VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' })
    );
    const admin = await import('@kilocode/web-shared/lib/ai-gateway/auto-routing-admin-client');

    await expect(admin.getAutoRoutingClassifierModel()).resolves.toMatchObject({ status: 500 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses sts to any https host other than the receiver origin', async () => {
    mockSwitches.AUTO_ROUTING_ADMIN_SENDER_AUTH = 'sts';
    mockWorkerUrl.value = 'https://auto-routing.example.com';
    try {
      const clients = await loadWeb();

      await expect(clients.autoRoutingRead()).resolves.toMatchObject({ status: 500 });
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      mockWorkerUrl.value = 'https://auto-routing.kiloapps.io';
    }
  });
});
