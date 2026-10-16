import { createServer } from 'node:http';
import { createTestHarness } from 'wrangler';
import { expect, it, vi } from 'vitest';
import { usage } from './usage.test-fixture';

it.each([undefined, 'staging'])(
  'processes the configured %s entry through Queues and the real HTTP writer client',
  async env => {
    const calls: {
      path: string | undefined;
      body: unknown;
      secret: string | string[] | undefined;
      bypass: string | string[] | undefined;
    }[] = [];
    const release = Promise.withResolvers<void>();
    const writer = createServer(async (request, response) => {
      let body = '';
      for await (const chunk of request) body += chunk;
      calls.push({
        path: request.url,
        body: JSON.parse(body),
        secret: request.headers['x-internal-api-key'],
        bypass: request.headers['x-vercel-protection-bypass'],
      });
      await release.promise;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          status: calls.length === 1 ? 'recorded' : 'duplicate',
          result: {
            usageId: usage.core.id,
            createdAt: usage.core.created_at,
            newMicrodollarsUsed: calls.length === 1 ? usage.core.cost : null,
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
      if (!address || typeof address === 'string')
        throw new Error('Missing loopback writer address');
      const server = createTestHarness({
        workers: [
          {
            configPath: new URL('../wrangler.jsonc', import.meta.url),
            env,
            vars: {
              USAGE_INGEST_MODE: 'processing',
              USAGE_WRITER_URL: `http://127.0.0.1:${address.port}/api/internal/usage/record`,
            },
            secrets: {
              USAGE_INGEST_PUBLISH_SECRET: 'local-publisher',
              USAGE_WRITER_SECRET: 'local-writer',
              USAGE_WRITER_PROTECTION_BYPASS: 'local-bypass',
            },
          },
        ],
      });
      harness = server;
      const { url } = await server.listen();
      const event = {
        ...usage,
        bouncer_usage_event: { request_id: 'local-request', payload: { spend: 1234 } },
      };
      const publish = () =>
        fetch(new URL('/usage', url), {
          method: 'POST',
          headers: { Authorization: 'Bearer local-publisher' },
          body: JSON.stringify(event),
        });
      expect((await publish()).status).toBe(202);
      await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 10_000 });
      // The writer has received the event, but has not yet acknowledged it.
      expect(server.getLogs()).toEqual([]);
      release.resolve();
      const processingLogs = () =>
        server
          .getLogs()
          .filter(log => log.message.includes('usage_ingest_processing'))
          .map(log => JSON.parse(log.message));
      await vi.waitFor(
        () => expect(processingLogs().map(log => log.outcome)).toEqual(['recorded']),
        { timeout: 10_000 }
      );
      expect((await publish()).status).toBe(202);
      await vi.waitFor(
        () => expect(processingLogs().map(log => log.outcome)).toEqual(['recorded', 'duplicate']),
        { timeout: 10_000 }
      );
      expect(calls).toEqual(
        Array.from({ length: 2 }, () => ({
          path: '/api/internal/usage/record',
          body: event,
          secret: 'local-writer',
          bypass: 'local-bypass',
        }))
      );
      expect(
        processingLogs().every(log => log.usage_id === usage.core.id && log.delivery_attempts === 1)
      ).toBe(true);
      for (const sensitive of [
        'local-publisher',
        'local-writer',
        'local-bypass',
        usage.metadata.user_prompt_prefix,
      ])
        expect(JSON.stringify(server.getLogs())).not.toContain(sensitive);
    } finally {
      release.resolve();
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
  },
  25_000
);
