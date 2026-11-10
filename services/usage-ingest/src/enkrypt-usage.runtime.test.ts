import { createServer } from 'node:http';
import { setTimeout } from 'node:timers/promises';
import { createTestHarness } from 'wrangler';
import { expect, it, vi } from 'vitest';
import { enkryptMessage, enkryptRecord } from './enkrypt-usage.test-fixture';
import { MAX_ENKRYPT_USAGE_BYTES } from './publish-enkrypt-usage';
import { usage } from './usage.test-fixture';

const publishSecret = 'local-enkrypt-publisher';
const writerSecret = 'local-enkrypt-writer';

it('carries an Enkrypt record from /enkrypt-usage through the queue and consumer to the Enkrypt writer and ACKs', async () => {
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
    response.end(JSON.stringify({ status: 'recorded', usageId: enkryptRecord.id }));
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
    const record = JSON.stringify(enkryptRecord);

    expect((await publish('/enkrypt-usage', record)).status).toBe(401);
    expect((await publish('/enkrypt-usage', record, 'Bearer wrong')).status).toBe(401);
    const oversized = JSON.stringify({
      ...enkryptRecord,
      sessionId: 'x'.repeat(MAX_ENKRYPT_USAGE_BYTES),
    });
    expect((await publish('/enkrypt-usage', oversized, `Bearer ${publishSecret}`)).status).toBe(
      413
    );
    expect(
      (await publish('/enkrypt-usage', JSON.stringify(usage), `Bearer ${publishSecret}`)).status
    ).toBe(400);
    expect(
      (await publish('/enkrypt-usage', JSON.stringify(enkryptMessage), `Bearer ${publishSecret}`))
        .status
    ).toBe(400);
    expect((await publish('/usage', record, `Bearer ${publishSecret}`)).status).toBe(400);

    expect((await publish('/enkrypt-usage', record, `Bearer ${publishSecret}`)).status).toBe(202);

    const outcomes = () =>
      server
        .getLogs()
        .filter(log => log.message.includes('usage_ingest_processing'))
        .map(log => JSON.parse(log.message));
    await vi.waitFor(() => expect(outcomes()).toHaveLength(1), { timeout: 10_000 });
    expect(outcomes()[0]).toMatchObject({
      usage_id: enkryptRecord.id,
      usage_kind: 'enkrypt_usage',
      queue_action: 'ack',
    });
    await setTimeout(250);
    expect(calls).toEqual([
      { path: '/api/internal/enkrypt-usage/record', body: enkryptRecord, source: 'queue' },
    ]);
    expect(outcomes()).toHaveLength(1);

    const logged = JSON.stringify(server.getLogs());
    for (const sensitive of [
      publishSecret,
      writerSecret,
      enkryptRecord.kiloUserId,
      enkryptRecord.sessionId,
      enkryptRecord.organizationId,
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
