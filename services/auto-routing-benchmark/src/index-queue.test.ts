/**
 * Queue-handler retry contract. DLQ messages must propagate processDeadLetter
 * errors (no ack) so the queue retries them: a lane death recorded without a
 * completed finalization has to be re-attempted, or the run wedges until the
 * stale sweep fails it wholesale.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RunModule from './run';

vi.mock('./auto-decider-sync', () => ({ syncAutoDeciderModels: vi.fn() }));

import { syncAutoDeciderModels } from './auto-decider-sync';
vi.mock('./run', async importOriginal => {
  const actual = await importOriginal<typeof RunModule>();
  return {
    ...actual,
    processDeadLetter: vi.fn(),
    processJob: vi.fn(),
    sweepStaleRunsAndDrain: vi.fn(),
  };
});

import {
  processDeadLetter,
  processJob,
  sweepStaleRunsAndDrain,
  type BenchmarkJobMessage,
} from './run';
import worker from './index';

const env = {} as unknown as Env;

function fakeBatch(queue: string, bodies: unknown[]) {
  const messages = bodies.map(body => ({ id: 'm', timestamp: 0, body, ack: vi.fn() }));
  return {
    batch: { queue, messages } as unknown as MessageBatch<BenchmarkJobMessage>,
    messages,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(processDeadLetter).mockResolvedValue(undefined);
  vi.mocked(processJob).mockResolvedValue(undefined);
});

describe('queue handler — DLQ branch', () => {
  it('acks dead-lettered messages after processDeadLetter succeeds', async () => {
    const { batch, messages } = fakeBatch('auto-routing-benchmark-dlq', [{ runId: 'r1' }]);

    await worker.queue(batch, env);

    expect(processDeadLetter).toHaveBeenCalledWith(env, { runId: 'r1' });
    expect(messages[0].ack).toHaveBeenCalled();
  });

  it('propagates processDeadLetter errors without ack so the queue retries', async () => {
    vi.mocked(processDeadLetter).mockRejectedValueOnce(new Error('D1 transient'));
    const { batch, messages } = fakeBatch('auto-routing-benchmark-dlq', [{ runId: 'r1' }]);

    await expect(worker.queue(batch, env)).rejects.toThrow('D1 transient');

    expect(messages[0].ack).not.toHaveBeenCalled();
  });
});

describe('queue handler — jobs branch', () => {
  it('acks jobs after processJob succeeds and propagates failures without ack', async () => {
    const { batch, messages } = fakeBatch('auto-routing-benchmark-jobs', [
      { runId: 'r1', kind: 'decider', model: 'm/x' },
    ]);

    await worker.queue(batch, env);

    expect(processJob).toHaveBeenCalledWith(env, {
      runId: 'r1',
      kind: 'decider',
      model: 'm/x',
    });
    expect(messages[0].ack).toHaveBeenCalled();

    vi.mocked(processJob).mockRejectedValueOnce(new Error('container capacity'));
    const retry = fakeBatch('auto-routing-benchmark-jobs', [{ runId: 'r1' }]);

    await expect(worker.queue(retry.batch, env)).rejects.toThrow('container capacity');
    expect(retry.messages[0].ack).not.toHaveBeenCalled();
  });
});

describe('scheduled router queues', () => {
  it('drains both routers on frequent ticks', async () => {
    vi.mocked(sweepStaleRunsAndDrain).mockResolvedValue({ staleRunIds: [], drained: [] });
    await worker.scheduled({ cron: '*/5 * * * *' } as ScheduledController, env);
    expect(sweepStaleRunsAndDrain).toHaveBeenCalledWith(env, 'efficient');
    expect(sweepStaleRunsAndDrain).toHaveBeenCalledWith(env, 'frontier');
  });

  it('syncs both routers at the platform cadence', async () => {
    vi.mocked(syncAutoDeciderModels).mockResolvedValue({
      addedModels: [],
      removedModels: [],
      platformEntries: 0,
      startedRuns: [],
      publishedVersion: null,
    });
    await worker.scheduled({ cron: '0 5 * * *' } as ScheduledController, env);
    expect(syncAutoDeciderModels).toHaveBeenCalledWith(env, { router: 'efficient' });
    expect(syncAutoDeciderModels).toHaveBeenCalledWith(env, { router: 'frontier' });
    expect(sweepStaleRunsAndDrain).not.toHaveBeenCalled();
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
