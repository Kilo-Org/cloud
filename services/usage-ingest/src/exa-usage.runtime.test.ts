import { createServer } from 'node:http';
import { createTestHarness } from 'wrangler';
import { expect, it, vi } from 'vitest';
import { exaRecord } from './exa-usage.test-fixture';
import { usage } from './usage.test-fixture';

it('carries an Exa record from /exa-usage through the queue to the Exa writer and back to ACK', async () => {
  const calls: { path: string | undefined; body: unknown; source: unknown }[] = [];
  let echo = '7b2d3f4a-5c6e-4f7a-9b8c-0d1e2f3a4b5c';
  const writer = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({
      path: request.url,
      body: JSON.parse(body),
      source: request.headers['x-usage-write-source'],
    });
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({ status: calls.length === 1 ? 'recorded' : 'duplicate', usageId: echo })
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
    const server = createTestHarness({
      workers: [
        {
          configPath: new URL('../wrangler.jsonc', import.meta.url),
          vars: {
            USAGE_WRITER_URL: `http://127.0.0.1:${address.port}/api/internal/usage/record`,
          },
          secrets: {
            USAGE_INGEST_PUBLISH_SECRET: 'local-llm-publisher',
            USAGE_INGEST_EXA_PUBLISH_SECRET: 'local-exa-publisher',
            USAGE_WRITER_SECRET: 'local-writer',
          },
        },
      ],
    });
    harness = server;
    const { url } = await server.listen();
    const publish = (path: string, body: unknown, secret: string) =>
      fetch(new URL(path, url), {
        method: 'POST',
        headers: { Authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
      });

    expect((await publish('/exa-usage', usage, 'local-exa-publisher')).status).toBe(400);
    expect((await publish('/usage', exaRecord, 'local-llm-publisher')).status).toBe(400);
    expect((await publish('/exa-usage', exaRecord, 'local-llm-publisher')).status).toBe(401);
    expect((await publish('/exa-usage', exaRecord, 'local-exa-publisher')).status).toBe(202);

    const outcomes = () =>
      server
        .getLogs()
        .filter(log => log.message.includes('usage_ingest_processing'))
        .map(log => JSON.parse(log.message));
    await vi.waitFor(() => expect(outcomes()).toHaveLength(1), { timeout: 10_000 });
    expect(outcomes()[0]).toMatchObject({
      usage_id: exaRecord.id,
      usage_kind: 'exa_usage',
      reason: 'invalid_response',
      queue_action: 'retry',
    });

    echo = exaRecord.id;
    expect((await publish('/exa-usage', exaRecord, 'local-exa-publisher')).status).toBe(202);
    await vi.waitFor(
      () => expect(outcomes().map(log => log.queue_action)).toEqual(['retry', 'ack']),
      { timeout: 10_000 }
    );
    expect(outcomes()[1]).toMatchObject({
      usage_id: exaRecord.id,
      usage_kind: 'exa_usage',
      outcome: 'duplicate',
    });
    expect(calls.slice(0, 2)).toEqual(
      Array.from({ length: 2 }, () => ({
        path: '/api/internal/exa-usage/record',
        body: exaRecord,
        source: 'queue',
      }))
    );
    const logged = JSON.stringify(server.getLogs());
    for (const sensitive of [
      'local-llm-publisher',
      'local-exa-publisher',
      'local-writer',
      exaRecord.userId,
    ])
      expect(logged).not.toContain(sensitive);
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
