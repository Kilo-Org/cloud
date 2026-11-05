import { unstable_readConfig, unstable_startWorker } from 'wrangler';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it, vi } from 'vitest';
import { usage } from './usage.test-fixture';

const publishSecret = 'synthetic-local-secret';

function ingressRequest() {
  return new Request('http://usage-observed.test/usage', {
    method: 'POST',
    headers: { authorization: `Bearer ${publishSecret}` },
    body: JSON.stringify(usage),
  });
}

function enqueueRecords(logs: unknown[]) {
  return logs.flatMap(entry => {
    const parsed = (entry as { message?: unknown }).message;
    if (typeof parsed !== 'string') return [];
    try {
      const record = JSON.parse(parsed) as Record<string, unknown>;
      return typeof record.event === 'string' && record.event.startsWith('usage_ingest_enqueue')
        ? [record]
        : [];
    } catch {
      return [];
    }
  });
}

it('registers the observation on the real ExecutionContext and logs one accepted completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'usage-observed-'));
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
        name: 'usage-observed',
        main: fileURLToPath(new URL('./index.ts', import.meta.url).href),
        compatibility_date: service.compatibility_date,
        compatibility_flags: service.compatibility_flags,
        vars: { ...service.vars, USAGE_INGEST_PUBLISH_SECRET: publishSecret },
        observability: { enabled: true },
        queues: service.queues,
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
    expect((await worker.fetch('http://usage-observed.test/')).status).toBe(404);
    const runtime = worker.raw.runtimes.find(runtime => runtime.mf)?.mf;
    if (!runtime) throw new Error('Expected local workerd runtime');
    const entrypoint = await runtime.getWorker();

    // workerd's direct entrypoint fetch has no connecting client, so this run proves the
    // real ExecutionContext registration and normal lifecycle, not a hosted disconnect.
    const response = await entrypoint.fetch(ingressRequest() as never);
    expect(response.status).toBe(202);

    await vi.waitFor(
      () =>
        expect(
          enqueueRecords(logs).filter(record => record.event === 'usage_ingest_enqueue_observed')
        ).toHaveLength(1),
      { timeout: 20_000, interval: 100 }
    );

    const records = enqueueRecords(logs);
    const names = records.map(record => record.event);
    expect(names.filter(name => name === 'usage_ingest_enqueue_start')).toHaveLength(1);
    expect(names.filter(name => name === 'usage_ingest_enqueue_observed')).toHaveLength(1);
    expect(names.filter(name => name === 'usage_ingest_enqueue')).toHaveLength(1);
    const observed = records.find(record => record.event === 'usage_ingest_enqueue_observed');
    expect(observed).toMatchObject({
      level: 'info',
      event: 'usage_ingest_enqueue_observed',
      usage_id: usage.core.id,
      outcome: 'accepted',
    });
    expect(observed?.send_duration_ms).toBeTypeOf('number');
    expect(JSON.stringify(observed)).not.toContain(publishSecret);
    expect(JSON.stringify(observed)).not.toContain(usage.metadata.user_prompt_prefix);
  } finally {
    try {
      await worker?.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}, 60_000);
