import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/sync.js', () => ({
  syncFromBench: vi.fn(),
}));

import { syncFromBench } from '../../src/sync.js';
import { handler } from '../../src/index.js';

function env(): CloudflareEnv {
  return {
    HYPERDRIVE: { connectionString: 'postgres://test' },
    BENCH_DASHBOARD: {
      listPromotions: vi.fn(async () => []),
      getPromotion: vi.fn(async () => null),
    },
  };
}

describe('scheduled model eval ingest handler', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('runs the bench sync on the cron trigger', async () => {
    vi.mocked(syncFromBench).mockResolvedValue({
      inserted: 0,
      alreadyHad: 0,
      fetched: 0,
      recomputed: 0,
      sinceMs: 0,
    });

    await handler.scheduled(
      { cron: '*/15 * * * *', scheduledTime: Date.now(), noRetry: vi.fn() },
      env(),
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() }
    );

    expect(syncFromBench).toHaveBeenCalledTimes(1);
  });
});
