import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { unstable_readConfig, unstable_startWorker } from 'wrangler';
import { usage } from './usage.test-fixture';

it('reports writer overload as a workerd queue exception while retaining individual decisions', async () => {
  const calls: unknown[] = [];
  let statuses: (number | 'recorded' | 'duplicate')[] = [];
  const writer = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const event = JSON.parse(body);
    calls.push(event);
    const status = statuses.shift();
    if (typeof status === 'number') {
      response.writeHead(status, { 'x-sensitive-header': 'synthetic-private-header' });
      response.end('synthetic-private-body');
    } else {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          status,
          result: {
            usageId: event.core.id,
            createdAt: event.core.created_at,
            newMicrodollarsUsed: 1234,
          },
        })
      );
    }
  });
  const directory = await mkdtemp(join(tmpdir(), 'usage-overload-'));
  let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
  const logs: unknown[] = [];
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
    // Compile the production entrypoint with its compatibility settings, without remote bindings.
    await writeFile(
      config,
      JSON.stringify({
        name: 'usage-overload-runtime',
        main: fileURLToPath(new URL('./index.ts', import.meta.url).href),
        compatibility_date: service.compatibility_date,
        compatibility_flags: service.compatibility_flags,
        vars: {
          USAGE_INGEST_MODE: 'processing',
          USAGE_WRITER_URL: `http://127.0.0.1:${address.port}/api/internal/usage/record`,
          USAGE_WRITER_SECRET: 'synthetic-writer-secret',
          USAGE_WRITER_PROTECTION_BYPASS: 'synthetic-bypass-secret',
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
        structuredLogsHandler: (log: unknown) => logs.push(log),
      },
    });
    await worker.ready;
    // Wrangler's direct queue helper targets its HTTP proxy rather than the local runtime.
    const runtime = worker.raw.runtimes.find(runtime => runtime.mf)?.mf;
    if (!runtime) throw new Error('Expected local workerd runtime');
    const entrypoint = await runtime.getWorker();
    const events = Array.from({ length: 4 }, (_, index) => ({
      ...usage,
      core: { ...usage.core, id: `4f2504e0-4f89-41d3-9a0c-0305e82c330${index}` },
    }));
    const messages = events.map((body, index) => ({
      id: `queue-${index}`,
      timestamp: new Date(),
      attempts: 2,
      body,
    }));
    for (const status of [429, 503]) {
      statuses = ['recorded', status, 400, 'duplicate'];
      const result = await entrypoint.queue('local-usage', messages);
      expect(result.outcome).toBe('exception');
      expect(result.ackAll).toBe(false);
      expect(result.explicitAcks).toEqual(['queue-0', 'queue-3']);
      expect(result.retryMessages.map(message => message.msgId)).toEqual(['queue-1', 'queue-2']);
      expect(calls.slice(-4)).toEqual(events);
      expect(statuses).toEqual([]);
      // A later delivery retains the usage identity and can settle as a duplicate.
      statuses = ['duplicate'];
      const replay = await entrypoint.queue('local-usage', [{ ...messages[1], attempts: 3 }]);
      expect(replay.outcome).toBe('ok');
      expect(replay.explicitAcks).toEqual(['queue-1']);
      expect(replay.retryMessages).toEqual([]);
      expect(calls.at(-1)).toEqual(events[1]);
    }
    for (const status of [400, 401, 403, 500, 502, 504]) {
      statuses = [status];
      const result = await entrypoint.queue('local-usage', [messages[0]]);
      expect(result.outcome).toBe('ok');
      expect(result.explicitAcks).toEqual([]);
      expect(result.retryMessages.map(message => message.msgId)).toEqual(['queue-0']);
    }
    expect(calls).toHaveLength(16);
    const serialized = JSON.stringify(logs);
    expect(serialized).toContain('usage_ingest_processing');
    expect(serialized).toContain('writer_overloaded');
    for (const sensitive of [
      'synthetic-writer-secret',
      'synthetic-bypass-secret',
      'synthetic-private-header',
      'synthetic-private-body',
      usage.metadata.user_prompt_prefix,
    ]) {
      expect(serialized).not.toContain(sensitive);
    }
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
