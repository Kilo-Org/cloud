import { createExecutionContext, env, waitOnExecutionContext } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from '../../src/e2e-entry.js';
import { logger } from '../../src/logger.js';
import type { Env } from '../../src/types.js';

afterEach(() => vi.restoreAllMocks());

describe('E2E background handler execution context', () => {
  const telemetryEnv = {
    ...env,
    CLOUD_AGENT_SENTRY_DSN: 'https://public@o1.ingest.sentry.io/42',
    CLOUD_AGENT_SENTRY_ENVIRONMENT: 'test',
  } as Env;

  it('runs the production queue handler with Sentry enabled', async () => {
    const warning = vi.spyOn(logger, 'warn');
    const ctx = createExecutionContext();
    const batch = { queue: 'review-test-unknown-queue', messages: [] } as unknown as MessageBatch;

    await worker.queue(batch, telemetryEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(warning).toHaveBeenCalledWith(
      'Received message from unexpected queue: review-test-unknown-queue'
    );
  });

  it('runs the production scheduled handler with Sentry enabled', async () => {
    const warning = vi.spyOn(logger, 'warn');
    const ctx = createExecutionContext();

    await worker.scheduled(
      { cron: '0 0 1 1 *', scheduledTime: Date.now() } as ScheduledController,
      telemetryEnv,
      ctx
    );
    await waitOnExecutionContext(ctx);

    expect(warning).toHaveBeenCalledWith(
      'Cloud Agent scheduled handler received an unrecognized cron',
      { cron: '0 0 1 1 *' }
    );
  });
});
