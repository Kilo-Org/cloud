import { createTestHarness } from 'wrangler';
import { expect, it, vi } from 'vitest';
import { setTimeout } from 'node:timers/promises';
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

it.each([undefined, 'staging'])(
  'delivers HTTP events through the configured %s queue to the shipped receipt consumer',
  async env => {
    const server = createTestHarness({
      workers: [
        {
          configPath: new URL('../wrangler.jsonc', import.meta.url),
          env,
          secrets: { USAGE_INGEST_PUBLISH_SECRET: 'synthetic-local-secret' },
        },
      ],
    });
    try {
      const { url } = await server.listen();
      const bindings = await server.getWorker<{ USAGE_INGEST_QUEUE: Queue<unknown> }>().getEnv();
      const post = (body: string) =>
        fetch(new URL('/usage', url), {
          method: 'POST',
          headers: { Authorization: 'Bearer synthetic-local-secret' },
          body,
        });
      const secondId = '4f2504e0-4f89-11d3-9a0c-0305e82c3302';
      const sentinel = 'SENSITIVE_SYNTHETIC_PROMPT_AND_METADATA';
      const event = {
        ...usage,
        core: { ...usage.core, created_at: new Date().toISOString() },
        metadata: { ...usage.metadata, user_prompt_prefix: sentinel, http_user_agent: sentinel },
        posthog_distinct_id: sentinel,
      };
      expect((await post('{')).status).toBe(400);
      expect(
        (await post(JSON.stringify({ ...event, core: { ...event.core, cost: 1.5 } }))).status
      ).toBe(400);
      expect((await bindings.USAGE_INGEST_QUEUE.metrics()).backlogCount).toBe(0);
      expect(server.getLogs()).toEqual([]);

      for (const id of [usage.core.id, secondId]) {
        expect((await post(JSON.stringify({ ...event, core: { ...event.core, id } }))).status).toBe(
          202
        );
      }
      // Runtime log capture and queue metrics observe the shipped handler without replacing it.
      await vi.waitFor(() => expect(server.getLogs().length).toBeGreaterThanOrEqual(2), {
        timeout: 10_000,
      });
      const receipts = server.getLogs().map(log => JSON.parse(log.message));
      expect([...new Set(receipts.map(receipt => receipt.usage_id))].sort()).toEqual(
        [usage.core.id, secondId].sort()
      );
      for (const receipt of receipts) {
        expect(receipt).toEqual({
          event: 'usage_ingest_receipt',
          outcome: 'received',
          usage_id: expect.any(String),
          queue_message_id: expect.any(String),
          delivery_attempts: expect.any(Number),
          event_age_ms: expect.any(Number),
        });
        expect(receipt.event_age_ms).toBeGreaterThanOrEqual(0);
        expect(receipt.delivery_attempts).toBeGreaterThanOrEqual(1);
      }

      // Bypass HTTP validation to exercise malformed-message discard in the shipped consumer.
      await bindings.USAGE_INGEST_QUEUE.send(
        { core: { id: sentinel }, token: 'synthetic-local-secret' },
        { contentType: 'json' }
      );
      await vi.waitFor(
        () =>
          expect(
            server
              .getLogs()
              .map(log => JSON.parse(log.message))
              .some(receipt => receipt.outcome === 'invalid')
          ).toBe(true),
        { timeout: 10_000 }
      );
      await setTimeout(500);
      for (const receipt of server.getLogs().map(log => JSON.parse(log.message))) {
        if (receipt.outcome === 'invalid') {
          expect(receipt).toEqual({
            event: 'usage_ingest_receipt',
            outcome: 'invalid',
            queue_message_id: expect.any(String),
            delivery_attempts: expect.any(Number),
          });
        } else {
          expect(receipt.outcome).toBe('received');
          expect([usage.core.id, secondId]).toContain(receipt.usage_id);
        }
      }
      expect(JSON.stringify(server.getLogs())).not.toContain(sentinel);
      expect(JSON.stringify(server.getLogs())).not.toContain('synthetic-local-secret');
      await vi.waitFor(async () =>
        expect((await bindings.USAGE_INGEST_QUEUE.metrics()).backlogCount).toBe(0)
      );
    } finally {
      await server.close();
    }
  },
  25_000
);
