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
    runDeciderCaseViaCli: vi.fn(),
    warmUpCliContainer: vi.fn(),
  };
});

import { runDeciderCaseViaCli, warmUpCliContainer, type CliRunResult } from './cli-runner';
import { countCaseResults, getRunWithModels, upsertCaseResult } from './db';
import { processJob } from './run';

const tokenGet = vi.fn<() => Promise<string>>();
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
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ token: 'kilo-user-token', expiresAt: '2026-06-16T01:00:00.000Z' })
    )
  );
  mockRunSnapshot();
  vi.mocked(countCaseResults).mockResolvedValue(0);
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
