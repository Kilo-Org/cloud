import { Container } from '@cloudflare/containers';
import { afterEach, expect, it, vi } from 'vitest';
import { BenchRunnerContainer } from './bench-runner-container';
import { isRetryableContainerAvailabilityError, runDeciderCaseViaCli } from './cli-runner';
import { DECIDER_CASES } from './datasets/decider-cases';

afterEach(() => {
  vi.restoreAllMocks();
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
