import { getWorkerDb } from '@kilocode/db/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { syncPromotionsFromBench } from './sync.js';
import worker from './index.js';

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: vi.fn() }));
vi.mock('./sync.js', () => ({
  createPromotionStore: vi.fn(),
  syncPromotionsFromBench: vi.fn(),
}));

const syncResult = {
  fetched: 3,
  inserted: 1,
  alreadyHad: 2,
  cacheRecomputes: 1,
};

function env(): CloudflareEnv {
  return {
    ENVIRONMENT: 'test',
    HYPERDRIVE: { connectionString: 'postgres://test' },
    BENCH_DASHBOARD: {},
    INTERNAL_API_SECRET: { get: async () => 'internal-secret' },
  } as unknown as CloudflareEnv;
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.mocked(getWorkerDb).mockReturnValue({} as never);
  vi.mocked(syncPromotionsFromBench).mockResolvedValue(syncResult);
});

describe('scheduled sync', () => {
  it('emits a canonical success event with sync counters and schedule metadata', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const controller = {
      cron: '*/15 * * * *',
      scheduledTime: 1_700_000_000_000,
    } as ScheduledController;

    await expect(worker.scheduled(controller, env())).resolves.toBeUndefined();

    expect(JSON.parse(String(info.mock.calls[0]?.[0]))).toMatchObject({
      event_name: 'scheduled_job.completed',
      event_version: 1,
      job_name: 'model_eval_ingest.sync',
      outcome: 'succeeded',
      environment: 'test',
      schedule: '*/15 * * * *',
      scheduled_time: 1_700_000_000_000,
      fetched_count: 3,
      inserted_count: 1,
      already_had_count: 2,
      cache_recompute_count: 1,
      no_op: false,
    });
  });

  it('emits a failure event and rethrows the sync error', async () => {
    const error = new Error('sync failed');
    vi.mocked(syncPromotionsFromBench).mockRejectedValueOnce(error);
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      worker.scheduled({ cron: '* * * * *' } as ScheduledController, env())
    ).rejects.toBe(error);

    expect(JSON.parse(String(errorLog.mock.calls[0]?.[0]))).toMatchObject({
      event_name: 'scheduled_job.completed',
      job_name: 'model_eval_ingest.sync',
      outcome: 'failed',
      exception_name: 'Error',
      schedule: '* * * * *',
    });
  });
});

it('does not emit a scheduled-job event for manual sync requests', async () => {
  const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);

  const response = await worker.fetch(
    new Request('https://model-eval-ingest/internal/sync', {
      method: 'POST',
      headers: { 'x-internal-api-key': 'internal-secret' },
    }),
    env()
  );

  expect(response.status).toBe(200);
  expect(info).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
});
