import { env } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { QUEUE_RETRY_DELAY_SECONDS, queue } from '../../src/queue-consumer';
import type { Env } from '../../src/env';

// The test Hyperdrive binding points at a Postgres that is not running, so a
// delivery fails at the session lookup. That is a retryable failure, not a
// payload the consumer can never parse.
function unavailableDatabaseEnv(): Env {
  return {
    ...env,
    HYPERDRIVE: { connectionString: 'postgres://postgres:postgres@127.0.0.1:1/postgres' },
  } as unknown as Env;
}

describe('ingest queue delivery failure', () => {
  it('keeps the staged object when a delivery fails so a dead-lettered message stays replayable', async () => {
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const kiloUserId = `usr_queue_${suffix}`;
    const sessionId = `ses_${suffix.slice(0, 26)}`;
    const r2Key = `ingest/${kiloUserId}/${sessionId}/req_${suffix}`;
    const body = JSON.stringify({ data: [{ type: 'message', data: { id: 'msg_1' } }] });
    await env.SESSION_INGEST_R2.put(r2Key, body);

    const ack = vi.fn();
    const retry = vi.fn();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      // The delivery count is past the consumer's configured retry cap, so the
      // queue dead-letters this message after the retry call.
      await queue(
        {
          messages: [
            {
              body: { r2Key, kiloUserId, sessionId, ingestVersion: 1, ingestedAt: 1 },
              attempts: 4,
              ack,
              retry,
            },
          ],
        } as never,
        unavailableDatabaseEnv(),
        { waitUntil: vi.fn() } as never
      );

      expect(retry).toHaveBeenCalledWith({ delaySeconds: QUEUE_RETRY_DELAY_SECONDS });
      expect(ack).not.toHaveBeenCalled();
      expect(await env.SESSION_INGEST_R2.head(r2Key)).not.toBeNull();
      await expect((await env.SESSION_INGEST_R2.get(r2Key))?.text()).resolves.toBe(body);
    } finally {
      consoleError.mockRestore();
      await env.SESSION_INGEST_R2.delete(r2Key);
    }
  });
});
