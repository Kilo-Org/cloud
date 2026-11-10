import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { unstable_readConfig, unstable_startWorker } from 'wrangler';
import { usage } from './usage.test-fixture';

const EVENT = 'usage_ingest_final_attempt_failed';

it('logs the final retry in workerd only for the last allowed failed delivery', async () => {
  let status: 'recorded' | 503 = 503;
  const writer = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const event = JSON.parse(body);
    if (status === 503) {
      response.writeHead(503);
      response.end();
      return;
    }
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        status,
        result: {
          usageId: event.core.id,
          createdAt: event.core.created_at,
          newMicrodollarsUsed: 1,
        },
      })
    );
  });
  const directory = await mkdtemp(join(tmpdir(), 'usage-final-attempt-'));
  let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
  const logs: { level?: string; message?: string }[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      writer.once('error', reject);
      writer.listen(0, '127.0.0.1', resolve);
    });
    const address = writer.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback writer');
    const service = unstable_readConfig({
      config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href),
    });
    const config = join(directory, 'wrangler.json');
    await writeFile(
      config,
      JSON.stringify({
        name: 'usage-final-attempt-runtime',
        main: fileURLToPath(new URL('./index.ts', import.meta.url).href),
        compatibility_date: service.compatibility_date,
        compatibility_flags: service.compatibility_flags,
        vars: {
          ...service.vars,
          USAGE_WRITER_URL: `http://127.0.0.1:${address.port}/api/internal/usage/record`,
          USAGE_WRITER_SECRET: 'synthetic-writer-secret',
        },
      })
    );
    worker = await unstable_startWorker({
      config,
      dev: {
        remote: false,
        persist: false,
        server: { hostname: '127.0.0.1', port: 0 },
        inspector: false,
        watch: false,
        structuredLogsHandler: (log: { level?: string; message?: string }) => logs.push(log),
      },
    });
    expect((await worker.fetch('http://usage-ingest.test/')).status).toBe(404);
    const runtime = worker.raw.runtimes.find(runtime => runtime.mf)?.mf;
    if (!runtime) throw new Error('Expected local workerd runtime');
    const entrypoint = await runtime.getWorker();
    const delivery = (attempts: number) => [
      { id: `queue-${attempts}`, timestamp: new Date(), attempts, body: usage },
    ];
    const finalLines = () =>
      logs.filter(log => log.message?.includes(EVENT)).map(log => JSON.parse(log.message ?? ''));

    const earlier = await entrypoint.queue('local-usage', delivery(20));
    expect(earlier.retryMessages.map(message => message.msgId)).toEqual(['queue-20']);
    expect(finalLines()).toEqual([]);

    const final = await entrypoint.queue('local-usage', delivery(21));
    expect(final.retryMessages.map(message => message.msgId)).toEqual(['queue-21']);
    expect(final.explicitAcks).toEqual([]);
    expect(finalLines()).toStrictEqual([
      {
        level: 'error',
        event: EVENT,
        queue: 'local-usage',
        usage_kind: 'llm',
        usage_id: usage.core.id,
        queue_message_id: 'queue-21',
        delivery_attempts: 21,
        reason: 'http_error',
      },
    ]);
    expect(logs.find(log => log.message?.includes(EVENT))?.level).toBe('error');

    status = 'recorded';
    const acknowledged = await entrypoint.queue('local-usage', delivery(21));
    expect(acknowledged.explicitAcks).toEqual(['queue-21']);
    expect(finalLines()).toHaveLength(1);
    expect(JSON.stringify(logs)).not.toContain('synthetic-writer-secret');
  } finally {
    try {
      await worker?.dispose();
    } finally {
      writer.closeAllConnections();
      if (writer.listening) {
        await new Promise<void>((resolve, reject) =>
          writer.close(error => (error ? reject(error) : resolve()))
        );
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 30_000);
