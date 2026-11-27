import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  waitOnExecutionContext,
} from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as dbClient from '@kilocode/db/client';

import { NotificationsService } from '../index';

// The bindings `env.staging` in wrangler.jsonc gives the Worker, and nothing
// else: no signer, provider credential, internal secret, STS, queue or service.
// Reading the database connection string throws, so a request that reaches the
// database path fails the test instead of answering.
function closedStageEnv() {
  const databaseReads = vi.fn();
  const stageEnv = {
    WORKER_ENV: 'staging',
    NOTIFICATIONS_PUSH_ENABLED: 'false',
    SECRETS_SOURCE: 'secrets-store',
    HYPERDRIVE: {
      get connectionString(): string {
        databaseReads();
        throw new Error('the closed stage must not read its database connection');
      },
    },
    NOTIFICATION_CHANNEL_DO: env.NOTIFICATION_CHANNEL_DO,
  };
  return { stageEnv, databaseReads };
}

describe('closed staging environment', () => {
  let dbSpy: ReturnType<typeof vi.spyOn>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    dbSpy = vi.spyOn(dbClient, 'getWorkerDb').mockImplementation(() => {
      throw new Error('the closed stage must not create a database client');
    });
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('the closed stage must not fetch'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Never verified: with no signer the middleware answers before the verifier.
  const SYNTHETIC_BEARER = 'Bearer synthetic.closed-stage.bearer';

  it('refuses a bearer with no signer bound before the verifier or any database read', async () => {
    const { stageEnv, databaseReads } = closedStageEnv();
    const service = new NotificationsService(createExecutionContext(), stageEnv as never);

    const badges = await service.fetch(
      new Request('https://example.com/v1/badges', {
        headers: { authorization: SYNTHETIC_BEARER },
      })
    );
    const markRead = await service.fetch(
      new Request('https://example.com/v1/badges/mark-read', {
        method: 'POST',
        headers: {
          authorization: SYNTHETIC_BEARER,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ badgeBucket: 'conv1' }),
      })
    );

    expect(badges.status).toBe(401);
    expect(markRead.status).toBe(401);
    expect(databaseReads).not.toHaveBeenCalled();
    expect(dbSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(['/internal/v1/dispatch', '/internal/v1/glanceable-refresh'])(
    'refuses %s with no internal secret bound, before any database read',
    async path => {
      const { stageEnv, databaseReads } = closedStageEnv();
      const service = new NotificationsService(createExecutionContext(), stageEnv as never);

      const res = await service.fetch(
        new Request(`https://example.com${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'X-Internal-Secret': 'any-value' },
          body: JSON.stringify({ userId: 'user-a', organizationId: null }),
        })
      );

      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'Unauthorized' });
      expect(databaseReads).not.toHaveBeenCalled();
      expect(dbSpy).not.toHaveBeenCalled();
    }
  );

  // Leaving the queue out of `env.staging` does not detach the live staging
  // consumer, so receipt batches can still arrive. Each is acknowledged with no
  // credential read, provider call or database read.
  it('acknowledges a residual receipt batch with no token, provider or database I/O', async () => {
    const { stageEnv, databaseReads } = closedStageEnv();
    const ctx = createExecutionContext();
    const service = new NotificationsService(ctx, stageEnv as never);
    const batch = createMessageBatch('notifications-receipts-staging', [
      {
        id: 'receipt-1',
        timestamp: new Date(),
        attempts: 1,
        body: { ticketTokenPairs: [{ ticketId: 'ticket-1', token: 'ExponentPushToken[stage]' }] },
      },
      {
        id: 'receipt-2',
        timestamp: new Date(),
        attempts: 3,
        body: { ticketTokenPairs: [{ ticketId: 'ticket-2', token: 'ExponentPushToken[stage]' }] },
      },
    ]);

    await service.queue(batch);
    await waitOnExecutionContext(ctx);
    const result = await getQueueResult(batch, ctx);

    expect(result.outcome).toBe('ok');
    expect(result.ackAll).toBe(false);
    expect([...result.explicitAcks].sort()).toEqual(['receipt-1', 'receipt-2']);
    expect(result.retryMessages).toEqual([]);
    expect(result.retryBatch.retry).toBe(false);
    expect(databaseReads).not.toHaveBeenCalled();
    expect(dbSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
