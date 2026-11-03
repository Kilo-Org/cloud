import { createTestHarness, unstable_readConfig, unstable_startWorker } from 'wrangler';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { usage } from './usage.test-fixture';

it('starts the configured Worker entry in workerd', async () => {
  const server = createTestHarness({
    workers: [
      {
        configPath: new URL('../wrangler.jsonc', import.meta.url),
        secrets: { USAGE_INGEST_PUBLISH_SECRET: 'synthetic-local-secret' },
      },
    ],
  });
  try {
    const { url } = await server.listen();
    const response = await fetch(new URL('/usage', url));
    expect(response.status).toBe(405);
    expect(response.headers.get('Allow')).toBe('POST');
    expect((await fetch(new URL('/usage', url), { method: 'POST' })).status).toBe(401);
  } finally {
    await server.close();
  }
}, 20_000);

it.each(['url', 'secret'])(
  'retries valid and invalid messages in workerd with missing writer %s',
  async missing => {
    const directory = await mkdtemp(join(tmpdir(), 'usage-missing-config-'));
    let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
    const logs: unknown[] = [];
    try {
      const service = unstable_readConfig({
        config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href),
      });
      const config = join(directory, 'wrangler.json');
      await writeFile(
        config,
        JSON.stringify({
          name: 'usage-missing-config',
          main: fileURLToPath(new URL('./index.ts', import.meta.url).href),
          compatibility_date: service.compatibility_date,
          compatibility_flags: service.compatibility_flags,
          vars: {
            ...service.vars,
            USAGE_WRITER_URL:
              missing === 'url' ? undefined : 'http://127.0.0.1:1/api/internal/usage/record',
            USAGE_WRITER_SECRET: missing === 'secret' ? undefined : 'synthetic-writer-secret',
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
      expect((await worker.fetch('http://usage-ingest.test/')).status).toBe(404);
      const runtime = worker.raw.runtimes.find(runtime => runtime.mf)?.mf;
      if (!runtime) throw new Error('Expected local workerd runtime');
      const entrypoint = await runtime.getWorker();
      const result = await entrypoint.queue(
        'local-usage',
        [usage, null].map((body, index) => ({
          id: `queue-${index}`,
          timestamp: new Date(),
          attempts: 1,
          body,
        }))
      );
      expect(result.outcome).toBe('ok');
      expect(result.ackAll).toBe(false);
      expect(result.explicitAcks).toEqual([]);
      expect(result.retryMessages.map(message => message.msgId).toSorted()).toEqual([
        'queue-0',
        'queue-1',
      ]);
      const serialized = JSON.stringify(logs);
      expect(serialized).toContain('missing_config');
      expect(serialized).toContain('invalid_event');
      expect(serialized).not.toContain('usage_ingest_receipt');
      expect(serialized).not.toContain('synthetic-writer-secret');
      expect(serialized).not.toContain(usage.metadata.user_prompt_prefix);
    } finally {
      try {
        await worker?.dispose();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  },
  20_000
);
