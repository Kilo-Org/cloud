import { createServer } from 'node:http';
import { createTestHarness, unstable_readConfig } from 'wrangler';
import { expect, it, vi } from 'vitest';
import { usage } from './usage.test-fixture';

it('keeps production direct and routes the existing staging consumer through the private relay', () => {
  const config = new URL('../wrangler.jsonc', import.meta.url).pathname;
  const production = unstable_readConfig({ config });
  const staging = unstable_readConfig({ config, env: 'staging' });
  expect(production.services).toEqual([]);
  expect(staging.services).toMatchObject([
    { binding: 'USAGE_WRITER_RELAY', service: 'usage-writer-relay-staging' },
  ]);
  expect(staging.name).toBe('usage-ingest-staging');
  expect(staging.queues.consumers).toMatchObject([
    {
      queue: 'usage-ingest-processing-staging',
      max_batch_size: 2,
      max_batch_timeout: 0,
      max_retries: 3,
      retry_delay: 60,
      max_concurrency: 100,
      dead_letter_queue: 'usage-ingest-processing-dlq-staging',
    },
  ]);
  const relay = unstable_readConfig({
    config: new URL('../wrangler.writer-relay.jsonc', import.meta.url).pathname,
  });
  expect(relay.placement).toMatchObject({ region: 'aws:eu-central-1' });
  expect(relay.workers_dev).toBe(false);
  expect(relay.preview_urls).toBe(false);
  expect(relay.routes).toEqual([]);
  expect(relay.vars.USAGE_WRITER_URL).toBe(staging.vars.USAGE_WRITER_URL);
});

it('runs the real queue -> service-binding fetch -> relay -> HTTP writer path', async () => {
  const calls: { path: string | undefined; body: unknown; headers: Record<string, unknown> }[] = [];
  const release = Promise.withResolvers<void>();
  const writer = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({ path: request.url, body: JSON.parse(body), headers: request.headers });
    await release.promise;
    if (calls.length === 3) {
      response.writeHead(503).end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        status: calls.length === 1 ? 'recorded' : 'duplicate',
        result: {
          usageId: usage.core.id,
          createdAt: usage.core.created_at,
          newMicrodollarsUsed: 1234,
        },
      })
    );
  });
  let server: ReturnType<typeof createTestHarness> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      writer.once('error', reject);
      writer.listen(0, '127.0.0.1', resolve);
    });
    const address = writer.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback writer');
    server = createTestHarness({
      workers: [
        {
          configPath: new URL('../wrangler.jsonc', import.meta.url),
          env: 'staging',
          vars: {
            // Direct egress here cannot reach the loopback writer. Only the relay
            // knows that target, proving this test traverses the service binding.
            USAGE_WRITER_URL: 'https://must-use-service-binding.invalid/api/internal/usage/record',
          },
          secrets: {
            USAGE_INGEST_PUBLISH_SECRET: 'synthetic-publisher',
            USAGE_WRITER_SECRET: 'synthetic-writer',
            USAGE_WRITER_PROTECTION_BYPASS: 'synthetic-bypass',
          },
        },
        {
          configPath: new URL('../wrangler.writer-relay.jsonc', import.meta.url),
          vars: { USAGE_WRITER_URL: `http://127.0.0.1:${address.port}/api/internal/usage/record` },
        },
      ],
    });
    const harness = server;
    const { url } = await harness.listen();
    const publish = () =>
      fetch(new URL('/usage', url), {
        method: 'POST',
        headers: { authorization: 'Bearer synthetic-publisher' },
        body: JSON.stringify(usage),
      });
    const processingLogs = () =>
      harness
        .getLogs()
        .filter(log => log.message.includes('usage_ingest_processing'))
        .map(log => JSON.parse(log.message));
    expect((await publish()).status).toBe(202);
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 10_000 });
    expect(processingLogs()).toEqual([]);
    release.resolve();
    await vi.waitFor(() => expect(processingLogs()).toHaveLength(1), { timeout: 10_000 });
    for (const count of [2, 3]) {
      expect((await publish()).status).toBe(202);
      await vi.waitFor(() => expect(processingLogs()).toHaveLength(count), { timeout: 10_000 });
    }
    expect(processingLogs().map(log => [log.outcome, log.queue_action])).toEqual([
      ['recorded', 'ack'],
      ['duplicate', 'ack'],
      ['unavailable', 'retry'],
    ]);
    expect(processingLogs()[2]).toMatchObject({
      writer_status: 503,
      invocation_failure: 'writer_overloaded',
    });
    for (const call of calls) {
      expect(call.path).toBe('/api/internal/usage/record');
      expect(call.body).toEqual(usage);
      expect(call.headers).toMatchObject({
        'x-internal-api-key': 'synthetic-writer',
        'x-vercel-protection-bypass': 'synthetic-bypass',
        'x-usage-write-source': 'queue',
      });
    }
    const logs = JSON.stringify(harness.getLogs());
    for (const value of [
      'synthetic-publisher',
      'synthetic-writer',
      'synthetic-bypass',
      usage.metadata.user_prompt_prefix,
    ]) {
      expect(logs).not.toContain(value);
    }
  } finally {
    release.resolve();
    await server?.close();
    await new Promise<void>((resolve, reject) =>
      writer.close(error => (error ? reject(error) : resolve()))
    );
  }
}, 45_000);
