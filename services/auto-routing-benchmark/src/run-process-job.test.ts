import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as CliRunnerModule from './cli-runner';
import type * as DbModule from './db';
import { DECIDER_CASES } from './datasets/decider-cases';

vi.mock('./db', async importOriginal => {
  const actual = await importOriginal<typeof DbModule>();
  return {
    ...actual,
    countCaseResults: vi.fn(),
    existsNewerCompletedRun: vi.fn(),
    getCaseResults: vi.fn(),
    getExistingCaseResultIds: vi.fn(),
    getRunWithModels: vi.fn(),
    getSummaries: vi.fn(),
    markRunCompleted: vi.fn(),
    replaceModelSummaries: vi.fn(),
    saveRoutingTable: vi.fn(),
    upsertCaseResult: vi.fn(),
  };
});

vi.mock('./cli-runner', async importOriginal => {
  const actual = await importOriginal<typeof CliRunnerModule>();
  return {
    ...actual,
    destroyDeciderCliContainer: vi.fn(),
    runDeciderCaseViaCli: vi.fn(),
    warmUpCliContainer: vi.fn(),
  };
});

import {
  destroyDeciderCliContainer,
  runDeciderCaseViaCli,
  warmUpCliContainer,
  type CliRunResult,
} from './cli-runner';
import {
  countCaseResults,
  getExistingCaseResultIds,
  getRunWithModels,
  upsertCaseResult,
} from './db';
import { processJob } from './run';

const tokenGet = vi.fn<() => Promise<string>>();
const queueSendBatch = vi.fn<(messages: unknown[]) => Promise<void>>();
const model = 'qwen/qwen3-coder-next';
const runId = 'decider-test-run';
const [benchCase] = DECIDER_CASES;

const successfulCliResult = {
  text: 'not the expected answer',
  costUsd: null,
  latencyMs: 25,
  exitCode: 0,
  stderrTail: '',
  eventCount: 1,
  lastEventTypes: ['session.created'],
  timedOut: false,
} satisfies CliRunResult;

const env = {
  INTERNAL_API_SECRET_PROD: { get: tokenGet },
  BENCH_DB: {} as D1Database,
  BENCH_QUEUE: { sendBatch: queueSendBatch },
  AUTO_ROUTING_CONFIG: { delete: vi.fn() },
} as unknown as Env;

function mockRunSnapshot(): void {
  vi.mocked(getRunWithModels).mockResolvedValue({
    run: {
      max_concurrency: 4,
      min_accuracy: 0.7,
      switch_cost_factor: 3,
      benchmark_user_id: 'benchmark-user',
      repetitions: 1,
      classifier_max_p95_latency_ms: null,
      started_at: '2026-06-16T00:00:00.000Z',
    },
    models: [{ model, enqueued: true, reasoning_effort: null }],
  } as never);
}

function deciderMessage() {
  return {
    runId,
    kind: 'decider',
    model,
    caseIds: [benchCase.id],
    chunk: 0,
    rep: 0,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  tokenGet.mockResolvedValue('internal-secret');
  queueSendBatch.mockResolvedValue(undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ token: 'kilo-user-token', expiresAt: '2026-06-16T01:00:00.000Z' })
    )
  );
  mockRunSnapshot();
  vi.mocked(countCaseResults).mockResolvedValue(0);
  vi.mocked(getExistingCaseResultIds).mockResolvedValue(new Set());
  vi.mocked(destroyDeciderCliContainer).mockResolvedValue(undefined);
  vi.mocked(warmUpCliContainer).mockResolvedValue(undefined);
  vi.mocked(runDeciderCaseViaCli).mockResolvedValue(successfulCliResult);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('processJob — decider container availability failures', () => {
  it.each([
    'container /run failed: HTTP 503 There is no Container instance available at this time. This is likely because you have reached your max concurrent instance count.',
    'container /run failed: HTTP 503 Maximum number of running container instances exceeded',
    'container /run failed: HTTP 503 There is no container instance that can be provided to this Durable Object, try again later',
  ])('lets the queue retry %s', async message => {
    vi.mocked(runDeciderCaseViaCli).mockRejectedValueOnce(new Error(message));

    await expect(processJob(env, deciderMessage())).rejects.toThrow(message);

    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(countCaseResults).not.toHaveBeenCalled();
  });

  it('lets the queue retry warmup capacity failures before running cases', async () => {
    const message =
      'container /warmup failed: HTTP 503 There is no Container instance available at this time';
    vi.mocked(warmUpCliContainer).mockRejectedValueOnce(new Error(message));

    await expect(processJob(env, deciderMessage())).rejects.toThrow(message);

    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(countCaseResults).not.toHaveBeenCalled();
  });
});

describe('processJob — decider chunk chaining', () => {
  it('runs a chunk on the model-repetition shard container and enqueues the next chunk', async () => {
    const message = {
      ...deciderMessage(),
      caseIds: DECIDER_CASES.slice(0, 5).map(c => c.id),
    };

    await processJob(env, message);

    expect(warmUpCliContainer).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ instanceName: `${runId}:${model}:0:0` })
    );
    expect(runDeciderCaseViaCli).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ instanceName: `${runId}:${model}:0:0` })
    );
    expect(queueSendBatch).toHaveBeenCalledWith([
      {
        body: {
          runId,
          kind: 'decider',
          model,
          chunk: 1,
          shard: 0,
          shardCount: 1,
          rep: 0,
          caseIds: DECIDER_CASES.slice(5, 10).map(c => c.id),
        },
      },
    ]);
    expect(countCaseResults).not.toHaveBeenCalled();
  });

  it('enqueues the next chunk assigned to the same shard lane', async () => {
    const chunk = 2;
    const shard = 2;
    const shardCount = 8;
    const currentCaseIds = DECIDER_CASES.slice(chunk * 5, chunk * 5 + 5).map(c => c.id);
    const nextChunk = chunk + shardCount;
    const nextCaseIds = DECIDER_CASES.slice(nextChunk * 5, nextChunk * 5 + 5).map(c => c.id);

    await processJob(env, {
      ...deciderMessage(),
      chunk,
      shard,
      shardCount,
      caseIds: currentCaseIds,
    });

    expect(warmUpCliContainer).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ instanceName: `${runId}:${model}:0:2` })
    );
    expect(queueSendBatch).toHaveBeenCalledWith([
      {
        body: {
          runId,
          kind: 'decider',
          model,
          chunk: nextChunk,
          shard,
          shardCount,
          rep: 0,
          caseIds: nextCaseIds,
        },
      },
    ]);
    expect(countCaseResults).not.toHaveBeenCalled();
  });

  it('does not rerun completed chunk cases or enqueue a fully completed next chunk', async () => {
    const currentCaseIds = DECIDER_CASES.slice(0, 5).map(c => c.id);
    const nextCaseIds = DECIDER_CASES.slice(5, 10).map(c => c.id);
    vi.mocked(getExistingCaseResultIds)
      .mockResolvedValueOnce(new Set(currentCaseIds))
      .mockResolvedValueOnce(new Set(nextCaseIds));

    await processJob(env, { ...deciderMessage(), caseIds: currentCaseIds });

    expect(warmUpCliContainer).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(queueSendBatch).not.toHaveBeenCalled();
  });

  it('re-enqueues a partially completed next chunk so DLQ leftovers cannot strand a run', async () => {
    const currentCaseIds = DECIDER_CASES.slice(0, 5).map(c => c.id);
    const nextCaseIds = DECIDER_CASES.slice(5, 10).map(c => c.id);
    vi.mocked(getExistingCaseResultIds)
      .mockResolvedValueOnce(new Set(currentCaseIds))
      .mockResolvedValueOnce(new Set([nextCaseIds[0]]));

    await processJob(env, { ...deciderMessage(), caseIds: currentCaseIds });

    expect(warmUpCliContainer).not.toHaveBeenCalled();
    expect(runDeciderCaseViaCli).not.toHaveBeenCalled();
    expect(upsertCaseResult).not.toHaveBeenCalled();
    expect(queueSendBatch).toHaveBeenCalledWith([
      {
        body: {
          runId,
          kind: 'decider',
          model,
          chunk: 1,
          shard: 0,
          shardCount: 1,
          rep: 0,
          caseIds: nextCaseIds,
        },
      },
    ]);
  });

  it('destroys the model-repetition shard container after the terminal chunk', async () => {
    const terminalChunk = Math.floor((DECIDER_CASES.length - 1) / 5);
    const terminalCaseIds = DECIDER_CASES.slice(terminalChunk * 5).map(c => c.id);

    await processJob(env, {
      ...deciderMessage(),
      chunk: terminalChunk,
      shard: 3,
      shardCount: 4,
      caseIds: terminalCaseIds,
    });

    expect(queueSendBatch).not.toHaveBeenCalled();
    expect(destroyDeciderCliContainer).toHaveBeenCalledWith(env, {
      instanceName: `${runId}:${model}:0:3`,
    });
    expect(countCaseResults).toHaveBeenCalled();
  });

  it('finalizes terminal chunks even when best-effort container destroy fails', async () => {
    const terminalChunk = Math.floor((DECIDER_CASES.length - 1) / 5);
    const terminalCaseIds = DECIDER_CASES.slice(terminalChunk * 5).map(c => c.id);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.mocked(destroyDeciderCliContainer).mockRejectedValueOnce(new Error('already stopped'));

    await processJob(env, {
      ...deciderMessage(),
      chunk: terminalChunk,
      shard: 3,
      shardCount: 4,
      caseIds: terminalCaseIds,
    });

    expect(destroyDeciderCliContainer).toHaveBeenCalledWith(env, {
      instanceName: `${runId}:${model}:0:3`,
    });
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('benchmark_container_destroy_failed')
    );
    expect(countCaseResults).toHaveBeenCalled();
    warn.mockRestore();
  });
});
