import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createTestHarness, unstable_readConfig } from 'wrangler';
import { expect, it, vi } from 'vitest';
import { usage } from './usage.test-fixture';

it('consumes a copy published to the staging hedge queue once, and its EU duplicate as duplicate', async () => {
  const writes: unknown[] = [];
  const writer = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    writes.push(JSON.parse(body));
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        status: writes.length === 1 ? 'recorded' : 'duplicate',
        result: {
          usageId: usage.core.id,
          createdAt: usage.core.created_at,
          newMicrodollarsUsed: writes.length === 1 ? usage.core.cost : null,
        },
      })
    );
  });
  let harness: ReturnType<typeof createTestHarness> | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      writer.once('error', reject);
      writer.listen(0, '127.0.0.1', resolve);
    });
    const address = writer.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback writer address');
    const configPath = fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href);
    const staging = unstable_readConfig({ config: configPath, env: 'staging' });
    const queueFor = (binding: string): string => {
      for (const producer of staging.queues.producers) {
        if (producer.binding === binding && producer.queue) return producer.queue;
      }
      throw new Error(`Missing staging ${binding} binding`);
    };
    const hedgeQueue = queueFor('USAGE_INGEST_HEDGE_QUEUE');
    const mainQueue = queueFor('USAGE_INGEST_QUEUE');
    const server = createTestHarness({
      workers: [
        {
          configPath,
          env: 'staging',
          vars: {
            USAGE_WRITER_URL: `http://127.0.0.1:${address.port}/api/internal/usage/record`,
            // The main local send is fast, so a hedge would only add a timing-dependent copy.
            USAGE_INGEST_HEDGE_MODE: 'off',
          },
          secrets: {
            USAGE_INGEST_PUBLISH_SECRET: 'local-publisher',
            USAGE_WRITER_SECRET: 'local-writer',
          },
        },
        {
          // Publishes through the same ingress straight into the hedge queue, as a hedge send does.
          config: {
            name: 'hedge-queue-publisher',
            main: fileURLToPath(new URL('./index.ts', import.meta.url).href),
            compatibility_date: staging.compatibility_date,
            compatibility_flags: staging.compatibility_flags,
            vars: { USAGE_INGEST_PUBLISH_SECRET: 'local-publisher' },
            queues: { producers: [{ binding: 'USAGE_INGEST_QUEUE', queue: hedgeQueue }] },
          },
        },
      ],
    });
    harness = server;
    await server.listen();
    const publish = (worker?: string) =>
      server.getWorker(worker).fetch('http://usage.test/usage', {
        method: 'POST',
        headers: { Authorization: 'Bearer local-publisher' },
        body: JSON.stringify(usage),
      });
    const processing = () =>
      server
        .getLogs()
        .filter(log => log.message.includes('"usage_ingest_processing"'))
        .map(log => JSON.parse(log.message) as Record<string, unknown>);

    expect((await publish('hedge-queue-publisher')).status).toBe(202);
    await vi.waitFor(() => expect(processing()).toHaveLength(1), { timeout: 10_000 });
    expect((await publish()).status).toBe(202);
    await vi.waitFor(() => expect(processing()).toHaveLength(2), { timeout: 10_000 });

    expect(processing()).toMatchObject([
      { queue: hedgeQueue, outcome: 'recorded', queue_action: 'ack', usage_id: usage.core.id },
      { queue: mainQueue, outcome: 'duplicate', queue_action: 'ack', usage_id: usage.core.id },
    ]);
    expect(writes).toEqual([usage, usage]);
  } finally {
    try {
      await harness?.close();
    } finally {
      writer.closeAllConnections();
      if (writer.listening) {
        await new Promise<void>((resolve, reject) =>
          writer.close(error => (error ? reject(error) : resolve()))
        );
      }
    }
  }
}, 30_000);
