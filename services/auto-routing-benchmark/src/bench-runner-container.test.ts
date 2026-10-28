import { Container } from '@cloudflare/containers';
import { afterEach, expect, it, vi } from 'vitest';
import { BenchRunnerContainer } from './bench-runner-container';

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
