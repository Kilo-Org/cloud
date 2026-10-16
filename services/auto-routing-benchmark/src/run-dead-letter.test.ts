import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as DbModule from './db';
import type * as SchedulerModule from './scheduler';
import { DECIDER_CASES } from './datasets/decider-cases';

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    getLiveContainerLanes: vi.fn(),
    getRunWithModels: vi.fn(),
    markProfilesFailedForEntries: vi.fn(),
    markProfilesReadyForRun: vi.fn(),
    markRunCompleted: vi.fn(),
    markRunFailed: vi.fn(),
    recordLaneFailure: vi.fn(),
  };
});

vi.mock('./scheduler', async importOriginal => {
  const actual = await importOriginal<typeof SchedulerModule>();
  return {
    ...actual,
    claimScheduledChunks: vi.fn(),
    deferChunk: vi.fn(),
    getChunk: vi.fn(),
    recoverChunks: vi.fn(),
    scheduleRunChunks: vi.fn(),
  };
});

import {
  getLiveContainerLanes,
  getRunWithModels,
  markProfilesFailedForEntries,
  markProfilesReadyForRun,
  markRunCompleted,
  markRunFailed,
  recordLaneFailure,
} from './db';
import {
  claimScheduledChunks,
  deferChunk,
  getChunk,
  recoverChunks,
  scheduleRunChunks,
  type SchedulerClaim,
} from './scheduler';
import { processDeadLetter } from './run';

const queueSend = vi.fn();
const queueSendBatch = vi.fn();
const schedulerFirst = vi.fn();
const schedulerAll = vi.fn();
const schedulerRun = vi.fn();
const schedulerPrepare = vi.fn(() => {
  const statement = {
    first: schedulerFirst,
    all: schedulerAll,
    run: schedulerRun,
  };
  return { ...statement, bind: vi.fn(() => statement) };
});
const runId = 'profile-dead-1';
const claim = {
  id: 'chunk-27',
  run_id: runId,
  model: 'b/dead',
  variant: 'high',
  providers: '["provider-b"]',
  rep: 0,
  chunk: 27,
  case_ids: JSON.stringify([DECIDER_CASES[27].id]),
  slot: 3,
  token: 'owned-token',
  attempts: 2,
} satisfies SchedulerClaim;
const env = {
  BENCH_DB: { prepare: schedulerPrepare } as unknown as D1Database,
  BENCH_QUEUE: { send: queueSend, sendBatch: queueSendBatch },
  BENCHMARK_SCHEDULER_CONFIG: '{}',
  KILO_WEB_API_BASE_URL: 'https://app.test',
} as unknown as Env;

function deadLetterMessage() {
  return {
    runId,
    kind: 'decider' as const,
    model: claim.model,
    claimId: claim.id,
    claimToken: claim.token,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  schedulerFirst.mockResolvedValue(null);
  schedulerAll.mockResolvedValue({ results: [] });
  schedulerRun.mockResolvedValue({ meta: { changes: 0 } });
  queueSend.mockResolvedValue(undefined);
  vi.mocked(getChunk).mockResolvedValue(claim);
  vi.mocked(deferChunk).mockResolvedValue(undefined);
  vi.mocked(claimScheduledChunks).mockResolvedValue([]);
  vi.mocked(recoverChunks).mockResolvedValue([]);
  vi.mocked(scheduleRunChunks).mockResolvedValue(true);
  vi.mocked(getLiveContainerLanes).mockResolvedValue(0);
});

function expectNoDirectLaneDeath() {
  expect(recordLaneFailure).not.toHaveBeenCalled();
  expect(markRunCompleted).not.toHaveBeenCalled();
  expect(markRunFailed).not.toHaveBeenCalled();
  expect(markProfilesFailedForEntries).not.toHaveBeenCalled();
  expect(markProfilesReadyForRun).not.toHaveBeenCalled();
}

describe('processDeadLetter — scheduler claims', () => {
  it('defers only queued matching ownership without revoking a live execution', async () => {
    await processDeadLetter(env, deadLetterMessage());
    expect(getChunk).not.toHaveBeenCalled();
    expect(deferChunk).toHaveBeenCalledWith(
      env.BENCH_DB,
      claim.id,
      claim.token,
      expect.any(Number),
      true
    );
    expect(recoverChunks).toHaveBeenCalledWith(env.BENCH_DB, expect.any(Number));
    expect(claimScheduledChunks).toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();
    expectNoDirectLaneDeath();
  });

  it('ignores stale ownership while still dispatching other work', async () => {
    vi.mocked(getChunk).mockResolvedValue(null);
    await processDeadLetter(env, { ...deadLetterMessage(), claimToken: 'stale-token' });
    expect(getChunk).not.toHaveBeenCalled();
    expect(deferChunk).toHaveBeenCalledWith(
      env.BENCH_DB,
      claim.id,
      'stale-token',
      expect.any(Number),
      true
    );
    expect(claimScheduledChunks).toHaveBeenCalled();
    expectNoDirectLaneDeath();
  });

  it('dispatches a replacement using the newly claimed token rather than the dead message', async () => {
    const next = { ...claim, id: 'next-chunk', token: 'fresh-token', model: 'other/model' };
    vi.mocked(claimScheduledChunks).mockResolvedValueOnce([next]).mockResolvedValue([]);
    await processDeadLetter(env, deadLetterMessage());
    expect(queueSend).toHaveBeenCalledWith({
      runId,
      kind: 'decider',
      model: 'other/model',
      claimId: 'next-chunk',
      claimToken: 'fresh-token',
    });
    expectNoDirectLaneDeath();
  });

  it('propagates reconciliation failures so the DLQ message can be retried', async () => {
    vi.mocked(recoverChunks).mockRejectedValueOnce(new Error('D1 transient'));
    await expect(processDeadLetter(env, deadLetterMessage())).rejects.toThrow('D1 transient');
    expect(claimScheduledChunks).not.toHaveBeenCalled();
    expectNoDirectLaneDeath();
  });

  it('drops malformed messages without touching claims or lane accounting', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await processDeadLetter(env, { nope: true });
      expect(getChunk).not.toHaveBeenCalled();
      expect(deferChunk).not.toHaveBeenCalled();
      expect(claimScheduledChunks).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('benchmark_deadletter_invalid_message')
      );
      expectNoDirectLaneDeath();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('processDeadLetter — legacy migration', () => {
  function mockRun(status: 'running' | 'completed' | 'failed' = 'running') {
    vi.mocked(getRunWithModels).mockResolvedValue({
      run: {
        id: runId,
        router: 'efficient',
        kind: 'decider',
        status,
        started_at: '2026-08-07T09:00:00.000Z',
        min_accuracy: 0.7,
        switch_cost_factor: 3,
        best_accuracy_switch_threshold: 0.05,
        max_concurrency: 0,
        benchmark_user_id: 'user-1',
        benchmark_org_id: null,
        repetitions: 2,
        classifier_max_p95_latency_ms: null,
        purpose: 'platform',
      },
      models: [
        { model: 'b/dead', variant: 'high', enqueued: true, reasoning_effort: 'high' },
        { model: 'b/dead', variant: 'low', enqueued: true, reasoning_effort: 'low' },
      ],
    } as never);
  }

  it('schedules the whole run instead of recording death for a legacy shard', async () => {
    mockRun();
    const fetcher = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ data: [] }));
    try {
      await processDeadLetter(env, {
        runId,
        kind: 'decider',
        model: 'b/dead',
        rep: 99,
        shard: 8,
        chunk: 999,
        caseIds: ['obsolete-case'],
      });
      expect(scheduleRunChunks).toHaveBeenCalledWith(env.BENCH_DB, {
        runId,
        entries: [
          { model: 'b/dead', variant: 'high', providers: [] },
          { model: 'b/dead', variant: 'low', providers: [] },
        ],
        repetitions: 2,
        caseIds: DECIDER_CASES.map(c => c.id),
        chunkSize: 1,
      });
      expect(deferChunk).not.toHaveBeenCalled();
      expect(claimScheduledChunks).toHaveBeenCalled();
      expectNoDirectLaneDeath();
    } finally {
      fetcher.mockRestore();
    }
  });

  it.each(['completed', 'failed'] as const)('does not initialize a %s legacy run', async status => {
    mockRun(status);
    await processDeadLetter(env, { runId, kind: 'decider', model: 'b/dead' });
    expect(scheduleRunChunks).not.toHaveBeenCalled();
    expect(claimScheduledChunks).toHaveBeenCalled();
    expectNoDirectLaneDeath();
  });
});
