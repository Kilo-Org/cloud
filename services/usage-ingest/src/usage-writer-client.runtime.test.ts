import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTestHarness } from 'wrangler';
import { expect, it } from 'vitest';
import { usage } from './usage.test-fixture';

it('calls a local HTTP writer from workerd and checks the acknowledgement', async () => {
  const received: { path: string; secret: string | string[] | undefined; body: unknown }[] = [];
  let status = 'recorded';
  const writer = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk.toString();
    received.push({
      path: request.url ?? '',
      secret: request.headers['x-internal-api-key'],
      body: JSON.parse(body),
    });
    response.setHeader('content-type', 'application/json');
    response.end(
      JSON.stringify({
        status,
        result:
          status === 'not_recorded'
            ? null
            : {
                usageId: usage.core.id,
                createdAt: usage.core.created_at,
                newMicrodollarsUsed: 1234,
              },
      })
    );
  });
  const directory = await mkdtemp(join(tmpdir(), 'usage-writer-client-'));
  let server: ReturnType<typeof createTestHarness> | undefined;
  try {
    const main = join(directory, 'worker.ts');
    const clientPath = fileURLToPath(new URL('./usage-writer-client.ts', import.meta.url).href);
    await new Promise<void>((resolve, reject) => {
      writer.once('error', reject);
      writer.listen(0, '127.0.0.1', resolve);
    });
    const address = writer.address();
    if (!address || typeof address === 'string') throw new Error('Expected local TCP address');
    const writerUrl = `http://127.0.0.1:${address.port}/api/internal/usage/record`;
    await writeFile(
      main,
      `
    import { recordUsage } from ${JSON.stringify(clientPath)};
    export default {
      async fetch(request) {
        return Response.json(await recordUsage(await request.json(), {
          url: ${JSON.stringify(writerUrl)}, secret: 'synthetic-writer-secret'
        }));
      }
    };
  `
    );
    server = createTestHarness({
      workers: [
        {
          config: {
            name: 'usage-writer-client-test',
            main,
            compatibility_date: '2026-09-18',
            compatibility_flags: ['nodejs_compat'],
          },
        },
      ],
    });
    const { url } = await server.listen();
    const invoke = async () =>
      (await fetch(url, { method: 'POST', body: JSON.stringify(usage) })).json();
    expect(await invoke()).toMatchObject({ kind: 'recorded', result: { usageId: usage.core.id } });
    status = 'duplicate';
    expect(await invoke()).toMatchObject({ kind: 'duplicate', result: { usageId: usage.core.id } });
    status = 'not_recorded';
    expect(await invoke()).toEqual({ kind: 'unavailable', reason: 'not_recorded' });
    expect(received).toEqual(
      Array.from({ length: 3 }, () => ({
        path: '/api/internal/usage/record',
        secret: 'synthetic-writer-secret',
        body: usage,
      }))
    );
    expect(JSON.stringify(server.getLogs())).not.toContain('synthetic-writer-secret');
    expect(JSON.stringify(server.getLogs())).not.toContain(usage.metadata.user_prompt_prefix);
  } finally {
    try {
      await server?.close();
    } finally {
      try {
        if (writer.listening) {
          await new Promise<void>((resolve, reject) =>
            writer.close(error => (error ? reject(error) : resolve()))
          );
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
}, 20_000);
