import { createServer } from 'node:http';
import { createTestHarness } from 'wrangler';
import { expect, it, vi } from 'vitest';
import { usage } from './usage.test-fixture';

it('writes directly in first mode and overflows a refused write to the queue', async () => {
  const calls: { source: string | string[] | undefined; body: unknown }[] = [];
  let directStatus = 200;
  const writer = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const source = request.headers['x-usage-write-source'];
    calls.push({ source, body: JSON.parse(body) });
    response.setHeader('content-type', 'application/json');
    if (source === 'ingress_direct' && directStatus !== 200) {
      response.statusCode = directStatus;
      response.end(JSON.stringify({ error: 'Usage writer overloaded', reason: 'queue_limit' }));
      return;
    }
    response.end(
      JSON.stringify({
        status: 'recorded',
        result: {
          usageId: usage.core.id,
          createdAt: usage.core.created_at,
          newMicrodollarsUsed: usage.core.cost,
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
    harness = createTestHarness({
      workers: [
        {
          configPath: new URL('../wrangler.jsonc', import.meta.url),
          env: 'staging',
          vars: {
            USAGE_WRITER_URL: `http://127.0.0.1:${address.port}/api/internal/usage/record`,
            USAGE_INGEST_DIRECT_MODE: 'first',
          },
          secrets: {
            USAGE_INGEST_PUBLISH_SECRET: 'local-publisher',
            USAGE_WRITER_SECRET: 'local-writer',
          },
        },
      ],
    });
    const { url } = await harness.listen();
    const server = harness;
    const publish = () =>
      fetch(new URL('/usage', url), {
        method: 'POST',
        headers: { Authorization: 'Bearer local-publisher' },
        body: JSON.stringify(usage),
      });
    const records = (event: string) =>
      server
        .getLogs()
        .filter(log => log.message.includes(event))
        .map(log => JSON.parse(log.message) as Record<string, unknown>);

    expect((await publish()).status).toBe(202);
    expect(calls.map(call => call.source)).toEqual(['ingress_direct']);
    expect(calls[0]?.body).toEqual(usage);
    expect(records('usage_ingest_publish')).toMatchObject([
      { mode: 'first', lane: 'direct', direct_outcome: 'recorded', rate_limited: false },
    ]);
    expect(records('usage_ingest_enqueue_start')).toEqual([]);

    directStatus = 429;
    expect((await publish()).status).toBe(202);
    await vi.waitFor(
      () =>
        expect(records('usage_ingest_processing').map(log => log.outcome)).toEqual(['recorded']),
      { timeout: 10_000 }
    );
    expect(calls.map(call => call.source)).toEqual(['ingress_direct', 'ingress_direct', 'queue']);
    expect(records('usage_ingest_publish')).toMatchObject([
      { lane: 'direct' },
      {
        mode: 'first',
        lane: 'queue',
        direct_outcome: 'http_error',
        direct_status: 429,
        direct_admission_reason: 'queue_limit',
        rate_limited: false,
      },
    ]);
    expect(JSON.stringify(server.getLogs())).not.toContain('local-writer');
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
}, 25_000);

it('answers from the queue without a direct write in the committed staging on_stall mode', async () => {
  const sources: (string | string[] | undefined)[] = [];
  const writer = createServer(async (request, response) => {
    for await (const _chunk of request);
    sources.push(request.headers['x-usage-write-source']);
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        status: 'recorded',
        result: {
          usageId: usage.core.id,
          createdAt: usage.core.created_at,
          newMicrodollarsUsed: usage.core.cost,
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
    harness = createTestHarness({
      workers: [
        {
          configPath: new URL('../wrangler.jsonc', import.meta.url),
          env: 'staging',
          vars: {
            USAGE_WRITER_URL: `http://127.0.0.1:${address.port}/api/internal/usage/record`,
          },
          secrets: {
            USAGE_INGEST_PUBLISH_SECRET: 'local-publisher',
            USAGE_WRITER_SECRET: 'local-writer',
          },
        },
      ],
    });
    const { url } = await harness.listen();
    const server = harness;
    const records = (event: string) =>
      server
        .getLogs()
        .filter(log => log.message.includes(event))
        .map(log => JSON.parse(log.message) as Record<string, unknown>);
    const response = await fetch(new URL('/usage', url), {
      method: 'POST',
      headers: { Authorization: 'Bearer local-publisher' },
      body: JSON.stringify(usage),
    });
    expect(response.status).toBe(202);
    expect(records('usage_ingest_publish')).toMatchObject([
      { mode: 'on_stall', lane: 'queue', status: 202, rate_limited: false },
    ]);
    expect(records('usage_ingest_publish')[0]).not.toHaveProperty('direct_outcome');
    await vi.waitFor(
      () =>
        expect(records('usage_ingest_processing').map(log => log.outcome)).toEqual(['recorded']),
      { timeout: 10_000 }
    );
    expect(sources).toEqual(['queue']);
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
}, 25_000);
