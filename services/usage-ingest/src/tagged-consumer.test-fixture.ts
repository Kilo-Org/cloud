import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type RequestListener } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect } from 'vitest';
import {
  unstable_readConfig,
  unstable_startWorker,
  type Unstable_Config as Config,
} from 'wrangler';

type ServiceConfig = Pick<Config, 'compatibility_date' | 'compatibility_flags' | 'vars'>;

type Runtime = {
  deliver: (...bodies: unknown[]) => ReturnType<Entrypoint['queue']>;
  logs: unknown[];
};

type Entrypoint = Awaited<
  ReturnType<
    NonNullable<
      Awaited<ReturnType<typeof unstable_startWorker>>['raw']['runtimes'][number]['mf']
    >['getWorker']
  >
>;

export async function withTaggedConsumerRuntime(
  name: string,
  handleWrite: RequestListener,
  run: (runtime: Runtime) => Promise<void>
) {
  const writer = createServer(handleWrite);
  const directory = await mkdtemp(join(tmpdir(), `usage-${name}-`));
  let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
  const logs: unknown[] = [];
  try {
    await new Promise<void>((resolve, reject) => {
      writer.once('error', reject);
      writer.listen(0, '127.0.0.1', resolve);
    });
    const address = writer.address();
    if (!address || typeof address === 'string') throw new Error('Expected loopback writer');
    // Type-aware lint resolves wrangler's config as `error` outside *.test.ts files.
    // oxlint-disable-next-line typescript/no-unsafe-assignment
    const { compatibility_date, compatibility_flags, vars }: ServiceConfig = unstable_readConfig({
      config: fileURLToPath(new URL('../wrangler.jsonc', import.meta.url).href),
    });
    const config = join(directory, 'wrangler.json');
    await writeFile(
      config,
      JSON.stringify({
        name: `usage-${name}-runtime`,
        main: fileURLToPath(new URL('./index.ts', import.meta.url).href),
        compatibility_date,
        compatibility_flags,
        vars: {
          ...vars,
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
    expect((await worker.fetch('http://usage-ingest.test/')).status).toBe(404);
    const runtime = worker.raw.runtimes.find(runtime => runtime.mf)?.mf;
    if (!runtime) throw new Error('Expected local workerd runtime');
    const entrypoint = await runtime.getWorker();
    const deliver = (...bodies: unknown[]) =>
      entrypoint.queue(
        'local-usage',
        bodies.map((body, index) => ({
          id: `queue-${index}`,
          timestamp: new Date(),
          attempts: 1,
          body,
        }))
      );
    await run({ deliver, logs });
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
}
