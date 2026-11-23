import { Container } from '@cloudflare/containers';
import { afterEach, expect, it, vi } from 'vitest';
import { BenchRunnerContainer } from './bench-runner-container';
import {
  encodePaidGenerationHeader,
  isRetryableContainerAvailabilityError,
  runDeciderCaseViaCli,
} from './cli-runner';
import { DECIDER_CASES } from './datasets/decider-cases';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('relays the caller cancellation of a case through a signal of its own', async () => {
  const forwarded: Request[] = [];
  vi.spyOn(Container.prototype, 'fetch').mockImplementation(async request => {
    forwarded.push(request);
    return Response.json({ exitCode: 0 });
  });
  const container = new BenchRunnerContainer(
    {} as DurableObjectState<Record<string, never>>,
    {
      KILO_CLI_API_URL: 'https://api.test',
    } as Env
  );
  const caller = new AbortController();
  const incoming = new Request('http://container/run', {
    method: 'POST',
    body: '{}',
    signal: caller.signal,
  });

  const response = await container.fetch(incoming);

  expect(response.status).toBe(200);
  expect(forwarded).toHaveLength(1);
  const [request] = forwarded;
  expect(request.url).toBe('http://container/run');
  expect(await request.text()).toBe('{}');
  // workerd never passes an incoming request's own signal on to a subrequest; see
  // caller-cancellation.workerd.test.ts.
  expect(request.signal).not.toBe(incoming.signal);
  expect(request.signal.aborted).toBe(false);
  caller.abort();
  expect(request.signal.aborted).toBe(true);
});

async function runCaseAgainstLibraryResponse(body: string): Promise<unknown> {
  vi.spyOn(Container.prototype, 'fetch').mockResolvedValue(new Response(body, { status: 500 }));
  const container = new BenchRunnerContainer(
    {} as DurableObjectState<Record<string, never>>,
    { KILO_CLI_API_URL: 'https://api.test' } as Env
  );
  const env = {
    BENCH_RUNNER: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: (request: Request) => container.fetch(request) }),
    },
  } as unknown as Env;
  return runDeciderCaseViaCli(env, {
    instanceName: 'benchmark-slot:1',
    model: 'vendor/model',
    benchCase: DECIDER_CASES[0],
    kiloToken: 'kilo-user-token',
    kiloApiUrl: 'https://api.test',
  }).then(
    () => null,
    (error: unknown) => error
  );
}

it.each([
  'Failed to start container: You are requesting too many containers per second',
  'Failed to start container: Container exited before we could determine the container health, exit code: 1',
  'Error proxying request to container: The container just exited',
  'Error proxying request to container: The container is not running, consider calling start()',
])('reports a request that never reached the server as retryable capacity: %s', async body => {
  const error = await runCaseAgainstLibraryResponse(body);

  expect(error).toBeInstanceOf(Error);
  expect(isRetryableContainerAvailabilityError(error)).toBe(true);
  expect(String(error)).toContain(`HTTP 503 container not reached: ${body}`);
});

it.each([
  'Container suddenly disconnected, try again',
  'Error proxying request to container: Container port connection closed unexpectedly.',
  'Error proxying request to container: The client has disconnected',
  '{"error":"spawn failed"}',
])('keeps a failure that may follow a delivered request non-retryable: %s', async body => {
  const error = await runCaseAgainstLibraryResponse(body);

  expect(error).toBeInstanceOf(Error);
  expect(isRetryableContainerAvailabilityError(error)).toBe(false);
  expect(String(error)).toContain(`HTTP 500 ${body}`);
});

it('passes a decoded 500 through without the upstream encoding and length headers', async () => {
  const body = '{"error":"spawn failed"}';
  vi.spyOn(Container.prototype, 'fetch').mockResolvedValue(
    new Response(body, {
      status: 500,
      statusText: 'Internal Server Error',
      headers: {
        'content-encoding': 'gzip',
        'content-length': '7',
        'content-type': 'application/json',
      },
    })
  );
  const container = new BenchRunnerContainer(
    {} as DurableObjectState<Record<string, never>>,
    { KILO_CLI_API_URL: 'https://api.test' } as Env
  );

  const response = await container.fetch(
    new Request('http://container/run', { method: 'POST', body: '{}' })
  );

  expect(response.status).toBe(500);
  expect(response.statusText).toBe('Internal Server Error');
  expect(response.headers.get('content-encoding')).toBeNull();
  expect(response.headers.get('content-length')).toBeNull();
  expect(response.headers.get('content-type')).toBe('application/json');
  expect(await response.text()).toBe(body);
});

type FakeStorage = {
  get: (key: string) => Promise<unknown>;
  put: (key: string, value: unknown) => Promise<void>;
  delete: (key: string) => Promise<boolean>;
  list: (options?: { prefix?: string }) => Promise<Map<string, unknown>>;
};

function fakeStorage(): FakeStorage {
  const entries = new Map<string, unknown>();
  return {
    get: async key => entries.get(key),
    put: async (key, value) => {
      entries.set(key, value);
    },
    delete: async key => entries.delete(key),
    list: async (options = {}) =>
      new Map([...entries].filter(([key]) => key.startsWith(options.prefix ?? ''))),
  };
}

function createContainer(
  options: { storage?: FakeStorage; ledgerLive?: boolean; ledgerFault?: boolean } = {}
) {
  const db = {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          if (options.ledgerFault === true) throw new Error('D1_ERROR: overloaded');
          return options.ledgerLive === false ? null : { generation: 1 };
        },
      }),
    }),
  };
  return new BenchRunnerContainer(
    { storage: options.storage ?? fakeStorage() } as unknown as DurableObjectState<
      Record<string, never>
    >,
    { KILO_CLI_API_URL: 'https://api.test', BENCH_DB: db } as unknown as Env
  );
}

const probeExecution = {
  runId: 'run-1',
  model: 'vendor/model',
  variant: 'high',
  rep: 0,
  caseId: 'case-1',
  token: 'claim-token',
  attemptStartedAt: 1_700_000_000_000,
};

const probeInference = {
  url: 'https://worker.test/case-inference',
  authorization: 'Bearer capability-token',
  invocation: 'eyJzdGFydGVkQXQiOjF9',
  invocationHeader: 'x-kilo-benchmark-case',
};

function probeRequest(overrides: Record<string, unknown> = {}) {
  return new Request('http://container/probe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      execution: probeExecution,
      endpoint: 'responses',
      inference: probeInference,
      body: '{"model":"vendor/model"}',
      timeoutMs: 60_000,
      ...overrides,
    }),
  });
}

function cancelRequest(execution: unknown = probeExecution) {
  return new Request('http://container/cancel', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ execution }),
  });
}

it('answers a cancel for a stopped instance without starting a container', async () => {
  const forwarded = vi.spyOn(Container.prototype, 'fetch');
  const container = createContainer();
  vi.spyOn(container, 'getState').mockResolvedValue({
    status: 'stopped',
    lastChange: 0,
  });

  const response = await container.fetch(cancelRequest());

  expect(await response.json()).toEqual({ cancelled: false, state: 'not_running' });
  expect(forwarded).not.toHaveBeenCalled();
});

it('forwards a cancel for a running container even after its caller goes away', async () => {
  const forwarded: Request[] = [];
  vi.spyOn(Container.prototype, 'fetch').mockImplementation(async request => {
    forwarded.push(request);
    return Response.json({ cancelled: true, state: 'killed' });
  });
  const container = createContainer();
  vi.spyOn(container, 'getState').mockResolvedValue({ status: 'healthy', lastChange: 0 });
  const caller = new AbortController();

  const response = await container.fetch(
    new Request('http://container/cancel', {
      method: 'POST',
      body: JSON.stringify({ execution: probeExecution }),
      signal: caller.signal,
    })
  );

  expect(response.status).toBe(200);
  expect(forwarded).toHaveLength(1);
  expect(forwarded[0].url).toBe('http://container/cancel');
  expect(forwarded[0].signal).not.toBe(caller.signal);
  caller.abort();
  expect(forwarded[0].signal.aborted).toBe(false);
});

it('proxies a direct probe through the worker case route without starting a container', async () => {
  const containerFetch = vi.spyOn(Container.prototype, 'fetch');
  const worker = vi.fn(
    async (_url: string, _init: RequestInit) =>
      new Response('event: done\ndata: {}\n\n', {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
  );
  vi.stubGlobal('fetch', worker);
  const container = createContainer();

  const response = await container.fetch(probeRequest());

  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toBe('text/event-stream');
  expect(await response.text()).toBe('event: done\ndata: {}\n\n');
  expect(worker).toHaveBeenCalledOnce();
  expect(String(worker.mock.calls[0][0])).toBe('https://worker.test/case-inference/responses');
  const init = worker.mock.calls[0][1];
  expect(init.method).toBe('POST');
  expect(init.headers).toMatchObject({
    authorization: 'Bearer capability-token',
    'x-kilo-benchmark-case': probeInference.invocation,
    'content-type': 'application/json',
    accept: 'text/event-stream',
  });
  const modelRequestId = (init.headers as Record<string, string>)[
    'x-kilo-benchmark-model-request-id'
  ];
  expect(modelRequestId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
  expect(init.body).toBe('{"model":"vendor/model"}');
  expect(containerFetch).not.toHaveBeenCalled();
});

it('refuses a probe that names anything but a case-inference api', async () => {
  const worker = vi.fn();
  vi.stubGlobal('fetch', worker);
  const container = createContainer();

  const response = await container.fetch(
    probeRequest({ endpoint: 'https://evil.test/api/gateway/v1/responses' })
  );

  expect(response.status).toBe(400);
  expect(response.headers.get('x-benchmark-runner')).toBe('invalid');
  expect(worker).not.toHaveBeenCalled();
});

it('carries a Worker refusal stop from a probe and never one from an admitted reply', async () => {
  const worker = vi
    .fn()
    .mockResolvedValueOnce(
      new Response('{"error":{"reason":"no_payer"}}', {
        status: 402,
        headers: {
          'content-type': 'application/json',
          'x-kilo-benchmark-admission': 'refused',
          'x-kilo-benchmark-stop': 'no_payer',
        },
      })
    )
    .mockResolvedValueOnce(
      new Response('provider text says: paused, no_payer', {
        status: 200,
        headers: {
          'content-type': 'text/event-stream',
          'x-kilo-benchmark-admission': 'admitted',
          'x-kilo-benchmark-stop': 'paused',
        },
      })
    );
  vi.stubGlobal('fetch', worker);
  const container = createContainer();

  const refused = await container.fetch(probeRequest());
  expect(refused.status).toBe(402);
  expect(refused.headers.get('x-kilo-benchmark-stop')).toBe('no_payer');

  const other = probeRequest({ execution: { ...probeExecution, caseId: 'case-2' } });
  const admitted = await container.fetch(other);
  expect(admitted.status).toBe(200);
  expect(admitted.headers.get('x-kilo-benchmark-stop')).toBeNull();
  expect(await admitted.text()).toBe('provider text says: paused, no_payer');
});

it('aborts the in-flight probe of the generation it is cancelling', async () => {
  const released = Promise.withResolvers<void>();
  const gateway = vi.fn(async (_url: string, init: RequestInit) => {
    const signal = init.signal;
    if (!(signal instanceof AbortSignal)) throw new Error('probe fetch needs a signal');
    signal.addEventListener('abort', () => released.resolve(), { once: true });
    await released.promise;
    throw new DOMException('aborted', 'AbortError');
  });
  vi.stubGlobal('fetch', gateway);
  const container = createContainer();

  const probe = container.fetch(probeRequest());
  await vi.waitFor(() => expect(gateway).toHaveBeenCalledOnce());
  const cancelled = await container.fetch(cancelRequest());

  expect(await cancelled.json()).toEqual({ cancelled: true, state: 'killed' });
  const response = await probe;
  expect(response.status).toBe(409);
  expect(response.headers.get('x-benchmark-runner')).toBe('cancelled');
});

it('keeps a cancelled generation from starting after the runner object restarts', async () => {
  const storage = fakeStorage();
  const gateway = vi.fn();
  vi.stubGlobal('fetch', gateway);

  const beforeRestart = createContainer({ storage });
  expect(await beforeRestart.fetch(cancelRequest()).then(r => r.json())).toEqual({
    cancelled: false,
    state: 'not_running',
  });

  const afterRestart = createContainer({ storage });
  const refused = await afterRestart.fetch(probeRequest());

  expect(refused.status).toBe(409);
  expect(refused.headers.get('x-benchmark-runner')).toBe('cancelled');
  expect(gateway).not.toHaveBeenCalled();
});

it('forwards a run whose canonical generation is still executing', async () => {
  const forwarded = vi
    .spyOn(Container.prototype, 'fetch')
    .mockResolvedValue(
      Response.json({ exitCode: 0, durationMs: 1, stdoutLines: [], stderrTail: '' })
    );
  const container = createContainer();
  const generation = encodePaidGenerationHeader(probeExecution);
  if (generation === null) throw new Error('generation header was not encoded');

  const response = await container.fetch(
    new Request('http://container/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-benchmark-paid-generation': generation,
      },
      body: '{}',
    })
  );

  expect(response.status).toBe(200);
  expect(forwarded).toHaveBeenCalledOnce();
});

it('refuses a run whose canonical generation is no longer executing', async () => {
  const forwarded = vi.spyOn(Container.prototype, 'fetch');
  const container = createContainer({ ledgerLive: false });
  const generation = encodePaidGenerationHeader(probeExecution);
  if (generation === null) throw new Error('generation header was not encoded');

  const response = await container.fetch(
    new Request('http://container/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-benchmark-paid-generation': generation,
      },
      body: '{}',
    })
  );

  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    error: 'case not live',
    started: false,
    cancelled: false,
    reason: 'not_live',
  });
  expect(forwarded).not.toHaveBeenCalled();
});

it('fails closed when admission cannot be verified before a run starts', async () => {
  const forwarded = vi.spyOn(Container.prototype, 'fetch');
  const container = createContainer({ ledgerFault: true });
  const generation = encodePaidGenerationHeader(probeExecution);
  if (generation === null) throw new Error('generation header was not encoded');

  const response = await container.fetch(
    new Request('http://container/run', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-benchmark-paid-generation': generation,
      },
      body: '{}',
    })
  );

  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({
    error: 'case not live',
    started: false,
    cancelled: false,
    reason: 'ledger_unavailable',
  });
  expect(forwarded).not.toHaveBeenCalled();
});

it('fails closed without calling the case route when a probe admission is unverifiable', async () => {
  const worker = vi.fn();
  vi.stubGlobal('fetch', worker);
  const container = createContainer({ ledgerFault: true });

  const response = await container.fetch(probeRequest());

  expect(response.status).toBe(503);
  expect(response.headers.get('x-benchmark-runner')).toBe('ledger_unavailable');
  expect(worker).not.toHaveBeenCalled();
});

it('refuses a probe envelope that is not the issued capability pair', async () => {
  const worker = vi.fn();
  vi.stubGlobal('fetch', worker);
  const container = createContainer();

  const response = await container.fetch(
    probeRequest({ inference: { ...probeInference, authorization: 'bot-token' } })
  );

  expect(response.status).toBe(400);
  expect(response.headers.get('x-benchmark-runner')).toBe('invalid');
  expect(worker).not.toHaveBeenCalled();
});
