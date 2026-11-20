import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RunModule from './run';

vi.mock('./system-optimal', () => ({
  fetchProductionAutoMetrics: vi.fn(),
  reevaluateSystemOptimalSettings: vi.fn(),
}));

vi.mock('./subscriptions', () => ({
  dailyReconcileSubscriptions: vi.fn(),
  continueDailyReconcile: vi.fn(),
}));
import { continueDailyReconcile, dailyReconcileSubscriptions } from './subscriptions';
import { fetchProductionAutoMetrics, reevaluateSystemOptimalSettings } from './system-optimal';

vi.mock('./run', async importOriginal => {
  const actual = await importOriginal<typeof RunModule>();
  return {
    ...actual,
    processDeadLetter: vi.fn(),
    processJob: vi.fn(),
    sweepStaleRunsAndDrain: vi.fn(),
    sweepStaleRuns: vi.fn(),
    syncPlatformRegistry: vi.fn(),
    drainQueues: vi.fn(),
    publishPlatformRoutingTable: vi.fn(),
  };
});

import {
  processDeadLetter,
  processJob,
  sweepStaleRunsAndDrain,
  sweepStaleRuns,
  syncPlatformRegistry,
  drainQueues,
  publishPlatformRoutingTable,
  type BenchmarkJobMessage,
} from './run';
import worker from './index';

const send = vi.fn();
const env = { BENCH_QUEUE: { send } } as unknown as Env;

const dailyResult = {
  router: 'efficient' as const,
  day: '2026-11-20',
  platform: { status: 'ok' as const, attempts: 1 },
  owners: { status: 'ok' as const, reconciled: 1, pages: 1 },
};

function fakeBatch(queue: string, bodies: unknown[]) {
  const messages = bodies.map(body => ({
    id: 'm',
    timestamp: 0,
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  }));
  return {
    batch: { queue, messages } as unknown as MessageBatch<BenchmarkJobMessage>,
    messages,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processDeadLetter).mockResolvedValue(undefined);
  vi.mocked(processJob).mockResolvedValue(undefined);
  send.mockReset().mockResolvedValue(undefined);
  vi.mocked(dailyReconcileSubscriptions).mockResolvedValue(dailyResult);
  vi.mocked(continueDailyReconcile).mockResolvedValue(null);
  vi.mocked(fetchProductionAutoMetrics).mockResolvedValue(null);
  vi.mocked(reevaluateSystemOptimalSettings).mockResolvedValue(null);
});

describe('queue handler — DLQ branch', () => {
  it('acks dead-lettered messages after processDeadLetter succeeds', async () => {
    const { batch, messages } = fakeBatch('auto-routing-benchmark-dlq', [{ runId: 'r1' }]);

    await worker.queue(batch, env);

    expect(processDeadLetter).toHaveBeenCalledWith(env, { runId: 'r1' });
    expect(messages[0].ack).toHaveBeenCalled();
  });

  it('retries failed scheduler reconciliation without acknowledging the dead letter', async () => {
    vi.mocked(processDeadLetter).mockRejectedValueOnce(new Error('D1 transient'));
    const { batch, messages } = fakeBatch('auto-routing-benchmark-dlq', [{ runId: 'r1' }]);
    await worker.queue(batch, env);
    expect(messages[0].ack).not.toHaveBeenCalled();
    expect(messages[0].retry).toHaveBeenCalledOnce();
  });
});

describe('queue handler — jobs branch', () => {
  it('acknowledges a token-owned claim after scheduler execution settles', async () => {
    const body = {
      runId: 'r1',
      kind: 'decider',
      model: 'm/x',
      claimId: 'chunk-1',
      claimToken: 'token-1',
    };
    const { batch, messages } = fakeBatch('auto-routing-benchmark-jobs', [body]);
    await worker.queue(batch, env);
    expect(processJob).toHaveBeenCalledWith(env, body);
    expect(messages[0].ack).toHaveBeenCalledOnce();
    expect(messages[0].retry).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('acknowledges scheduler wakeups without applying queue-level capacity redelivery', async () => {
    const body = { runId: 'r1', kind: 'decider', model: 'm/x', schedulerWake: true };
    const { batch, messages } = fakeBatch('auto-routing-benchmark-jobs', [body]);
    await worker.queue(batch, env);
    expect(processJob).toHaveBeenCalledWith(env, body);
    expect(messages[0].ack).toHaveBeenCalledOnce();
    expect(messages[0].retry).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('retains queue-level capacity compatibility for uncaught infrastructure waits', async () => {
    const body = { runId: 'r1', kind: 'decider', model: 'm/x' };
    vi.mocked(processJob).mockRejectedValueOnce(
      new Error('container /warmup failed: HTTP 503 capacity')
    );
    const { batch, messages } = fakeBatch('auto-routing-benchmark-jobs', [body]);
    await worker.queue(batch, env);
    expect(send).toHaveBeenCalledWith(body, { delaySeconds: 30 });
    expect(messages[0].ack).toHaveBeenCalledOnce();
    expect(messages[0].retry).not.toHaveBeenCalled();
  });

  it('retries the original job if capacity redispatch fails', async () => {
    vi.mocked(processJob).mockRejectedValueOnce(
      new Error('container /run failed: HTTP 503 capacity')
    );
    send.mockRejectedValueOnce(new Error('Queue unavailable'));
    const { batch, messages } = fakeBatch('auto-routing-benchmark-jobs', [{ runId: 'r1' }]);
    await worker.queue(batch, env);
    expect(messages[0].ack).not.toHaveBeenCalled();
    expect(messages[0].retry).toHaveBeenCalledOnce();
  });

  it('retries an infrastructure failure and processes the remaining jobs', async () => {
    vi.mocked(processJob).mockRejectedValueOnce(new Error('D1 transient'));
    const { batch, messages } = fakeBatch('auto-routing-benchmark-jobs', [
      { runId: 'r1' },
      { runId: 'r2' },
    ]);
    await worker.queue(batch, env);
    expect(messages[0].retry).toHaveBeenCalledOnce();
    expect(messages[0].ack).not.toHaveBeenCalled();
    expect(messages[1].ack).toHaveBeenCalledOnce();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('scheduled router queues', () => {
  it('drains both routers on frequent ticks', async () => {
    vi.mocked(sweepStaleRunsAndDrain).mockResolvedValue({ staleRunIds: [], drained: [] });
    await worker.scheduled({ cron: '*/5 * * * *' } as ScheduledController, env);
    expect(sweepStaleRunsAndDrain).toHaveBeenCalledWith(env, 'efficient');
    expect(sweepStaleRunsAndDrain).toHaveBeenCalledWith(env, 'frontier');
    expect(continueDailyReconcile).toHaveBeenCalledWith(env, 'efficient');
    expect(continueDailyReconcile).toHaveBeenCalledWith(env, 'frontier');
    expect(dailyReconcileSubscriptions).not.toHaveBeenCalled();
  });

  it('reconciles, drains, and republishes both routers at the platform cadence', async () => {
    vi.mocked(sweepStaleRuns).mockResolvedValue([]);
    vi.mocked(syncPlatformRegistry).mockResolvedValue({ desiredEntries: 0 });
    vi.mocked(drainQueues).mockResolvedValue([]);
    vi.mocked(publishPlatformRoutingTable).mockResolvedValue(null);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await worker.scheduled({ cron: '0 5 * * *' } as ScheduledController, env);
    expect(sweepStaleRuns).toHaveBeenCalledTimes(2);
    expect(dailyReconcileSubscriptions).toHaveBeenCalledTimes(2);
    for (const router of ['efficient', 'frontier'] as const) {
      expect(syncPlatformRegistry).toHaveBeenCalledWith(env, fetch, router);
      expect(dailyReconcileSubscriptions).toHaveBeenCalledWith(env, router);
      const dailyCall = vi.mocked(dailyReconcileSubscriptions).mock.invocationCallOrder[
        router === 'efficient' ? 0 : 1
      ];
      expect(dailyCall).toBeLessThan(
        vi.mocked(syncPlatformRegistry).mock.invocationCallOrder[router === 'efficient' ? 0 : 1]
      );
      expect(drainQueues).toHaveBeenCalledWith(env, 'both', undefined, router);
      expect(publishPlatformRoutingTable).toHaveBeenCalledWith(env, fetch, router);
    }
    const summaries = log.mock.calls
      .map(([message]) => JSON.parse(String(message)) as { event: string; router?: string })
      .filter(entry => entry.event === 'benchmark_daily_sync_summary');
    expect(summaries.map(entry => entry.router)).toEqual(['efficient', 'frontier']);
    log.mockRestore();
    expect(sweepStaleRunsAndDrain).not.toHaveBeenCalled();
  });

  it('keeps daily drain and publication running when subscription reconciliation fails', async () => {
    vi.mocked(sweepStaleRuns).mockResolvedValue([]);
    vi.mocked(syncPlatformRegistry).mockResolvedValue({ desiredEntries: 0 });
    vi.mocked(drainQueues).mockResolvedValue([]);
    vi.mocked(publishPlatformRoutingTable).mockResolvedValue(null);
    vi.mocked(dailyReconcileSubscriptions).mockRejectedValueOnce(new Error('catalog unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      worker.scheduled({ cron: '0 5 * * *' } as ScheduledController, env)
    ).rejects.toThrow('Benchmark scheduled routers failed');

    expect(syncPlatformRegistry).toHaveBeenCalledWith(env, fetch, 'efficient');
    expect(drainQueues).toHaveBeenCalledWith(env, 'both', undefined, 'efficient');
    expect(publishPlatformRoutingTable).toHaveBeenCalledWith(env, fetch, 'efficient');
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'benchmark_daily_step_failed',
        cron: '0 5 * * *',
        router: 'efficient',
        step: 'subscriptions',
        error: 'catalog unavailable',
      })
    );
    warn.mockRestore();
  });

  it('publishes and drains when the platform registry sync fails', async () => {
    vi.mocked(sweepStaleRuns).mockResolvedValue([]);
    vi.mocked(syncPlatformRegistry).mockRejectedValueOnce(new Error('D1 DB is overloaded'));
    vi.mocked(drainQueues).mockResolvedValue([]);
    vi.mocked(publishPlatformRoutingTable).mockResolvedValue({ version: 'registry-v1' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(
      worker.scheduled({ cron: '0 5 * * *' } as ScheduledController, env)
    ).rejects.toThrow('Benchmark scheduled routers failed');

    expect(drainQueues).toHaveBeenCalledWith(env, 'both', undefined, 'efficient');
    expect(publishPlatformRoutingTable).toHaveBeenCalledWith(env, fetch, 'efficient');
    expect(warn).toHaveBeenCalledWith(
      JSON.stringify({
        event: 'benchmark_daily_step_failed',
        cron: '0 5 * * *',
        router: 'efficient',
        step: 'registrySync',
        error: 'D1 DB is overloaded',
      })
    );
    warn.mockRestore();
  });

  it('reports an unfinished alias sync on the frequent tick', async () => {
    vi.mocked(sweepStaleRunsAndDrain).mockResolvedValue({ staleRunIds: [], drained: [] });
    vi.mocked(continueDailyReconcile).mockResolvedValue({
      ...dailyResult,
      owners: { status: 'pending', reconciled: 200, pages: 2 },
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    await worker.scheduled({ cron: '* * * * *' } as ScheduledController, env);
    const tick = log.mock.calls
      .map(([message]) => JSON.parse(String(message)) as Record<string, unknown>)
      .find(entry => entry.event === 'benchmark_queue_drain_tick_completed');
    expect(tick?.dailyAliasSync).toEqual({
      platform: dailyResult.platform,
      owners: { status: 'pending', reconciled: 200, pages: 2 },
    });
    log.mockRestore();
  });

  it('still drains frontier when the efficient drain fails and reports the failure', async () => {
    vi.mocked(sweepStaleRunsAndDrain)
      .mockRejectedValueOnce(new Error('efficient queue failed'))
      .mockResolvedValueOnce({ staleRunIds: [], drained: [] });
    await expect(
      worker.scheduled({ cron: '*/5 * * * *' } as ScheduledController, env)
    ).rejects.toThrow('Benchmark scheduled routers failed');
    expect(sweepStaleRunsAndDrain).toHaveBeenCalledWith(env, 'frontier');
  });
});
