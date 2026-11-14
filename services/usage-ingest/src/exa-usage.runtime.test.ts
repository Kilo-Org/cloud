import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { createTestHarness } from 'wrangler';
import { expect, it, vi } from 'vitest';
import { enkryptRecord } from './enkrypt-usage.test-fixture';
import { exaMessage, exaRecord } from './exa-usage.test-fixture';
import { MAX_EXA_USAGE_BYTES } from './publish-exa-usage';
import { usage } from './usage.test-fixture';

const publishSecret = 'local-exa-publisher';
const writerSecret = 'local-exa-writer';

it('carries an Exa record from /exa-usage through the queue and consumer to the Exa writer and ACKs', async () => {
  const calls: { path: string | undefined; body: unknown; source: unknown }[] = [];
  const writer = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    calls.push({
      path: request.url,
      body: JSON.parse(body),
      source: request.headers['x-usage-write-source'],
    });
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ status: 'recorded', usageId: exaRecord.id }));
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
            USAGE_INGEST_PUBLISH_SECRET: publishSecret,
            USAGE_WRITER_SECRET: writerSecret,
          },
        },
      ],
    });
    harness = server;
    const { url } = await server.listen();
    const publish = (path: string, body: string, authorization?: string) =>
      fetch(new URL(path, url), {
        method: 'POST',
        headers: authorization ? { Authorization: authorization } : undefined,
        body,
      });
    const record = JSON.stringify(exaRecord);
    const authorized = `Bearer ${publishSecret}`;

    expect((await publish('/exa-usage', record)).status).toBe(401);
    expect((await publish('/exa-usage', record, 'Bearer wrong')).status).toBe(401);
    const oversized = JSON.stringify({ ...exaRecord, type: 'x'.repeat(MAX_EXA_USAGE_BYTES) });
    expect((await publish('/exa-usage', oversized, authorized)).status).toBe(413);
    for (const body of [usage, enkryptRecord, exaMessage]) {
      expect((await publish('/exa-usage', JSON.stringify(body), authorized)).status).toBe(400);
    }
    expect((await publish('/usage', record, authorized)).status).toBe(400);
    expect((await publish('/enkrypt-usage', record, authorized)).status).toBe(400);

    expect((await publish('/exa-usage', record, authorized)).status).toBe(202);

    const outcomes = () =>
      server
        .getLogs()
        .filter(log => log.message.includes('usage_ingest_processing'))
        .map(log => JSON.parse(log.message));
    await vi.waitFor(() => expect(outcomes()).toHaveLength(1), { timeout: 10_000 });
    expect(outcomes()[0]).toMatchObject({
      usage_id: exaRecord.id,
      usage_kind: 'exa_usage',
      queue_action: 'ack',
    });
    await setTimeout(250);
    expect(calls).toEqual([
      { path: '/api/internal/exa-usage/record', body: exaRecord, source: 'queue' },
    ]);
    expect(outcomes()).toHaveLength(1);

    const logged = JSON.stringify(server.getLogs());
    for (const sensitive of [
      publishSecret,
      writerSecret,
      exaRecord.userId,
      exaRecord.organizationId,
      exaRecord.occurredAt,
      exaRecord.featureId,
      exaRecord.type,
    ])
      if (sensitive) expect(logged).not.toContain(sensitive);
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
