import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { DECIDER_CASES } from './datasets/decider-cases';
import {
  acceptContainerCaseResult,
  PAID_OUTPUT_WAIT_MS,
  processJob,
  type BenchmarkJobMessage,
} from './run';
import {
  claimScheduledChunks,
  scheduleRunChunks,
  schedulerConfig,
  type SchedulerClaim,
} from './scheduler';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const RUN_ID = 'canceled-invocation';
const SLOTS = JSON.stringify({ slots: 1 });

type Sent = { body: BenchmarkJobMessage; delaySeconds?: number };

describe('a paid case whose queue invocation is canceled (production migrations and real SQLite)', () => {
  let sqlite: DatabaseSync;
  let env: Env;
  let sent: Sent[];
  let runRequests: Request[];
  let runStarted: PromiseWithResolvers<void>;
  let claim: SchedulerClaim;
  let delivery: BenchmarkJobMessage;
  let answer: string;

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      Response.json({ token: 'kilo-user-token', expiresAt: '2026-10-16T13:00:00.000Z' })
    );
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    sent = [];
    runRequests = [];
    runStarted = Promise.withResolvers<void>();
    const container = {
      async fetch(request: Request): Promise<Response> {
        if (new URL(request.url).pathname === '/warmup') {
          return Response.json({ exitCode: 0, durationMs: 1 });
        }
        runRequests.push(request);
        runStarted.resolve();
        // The invocation awaiting this case is canceled, so its answer never arrives.
        return Promise.withResolvers<Response>().promise;
      },
    };
    env = {
      BENCH_DB: sqliteD1(sqlite),
      BENCH_QUEUE: {
        async send(body: BenchmarkJobMessage, options?: { delaySeconds?: number }) {
          sent.push({ body, delaySeconds: options?.delaySeconds });
        },
      },
      BENCH_RUNNER: { idFromName: (name: string) => name, get: () => container },
      BENCHMARK_SCHEDULER_CONFIG: SLOTS,
      BOT_TOKEN_MINT_SECRET: { get: async () => 'mint-secret' },
      KILO_WEB_API_BASE_URL: 'https://app.test',
      KILO_CLI_API_URL: 'https://api.test',
      BENCH_RESULT_URL: 'https://bench.test/container/case-result',
    } as unknown as Env;

    sqlite
      .prepare(`
      INSERT INTO benchmark_runs (
        id, router, kind, purpose, status, started_at, min_accuracy, switch_cost_factor,
        max_concurrency, repetitions, engine_identity, benchmark_user_id
      ) VALUES (?, 'efficient', 'decider', 'platform', 'running', ?, 0.7, 3, 0, 1, 'redelivery-test', 'benchmark-user')
    `)
      .run(RUN_ID, new Date(NOW).toISOString());
    const models = ['lane/model', 'other/model'];
    for (const model of models) {
      sqlite
        .prepare("INSERT INTO run_models (run_id, model, variant, enqueued) VALUES (?, ?, '', 1)")
        .run(RUN_ID, model);
    }
    await scheduleRunChunks(env.BENCH_DB, {
      runId: RUN_ID,
      entries: models.map(model => ({ model, variant: null, providers: ['deepinfra'] })),
      repetitions: 1,
      caseIds: DECIDER_CASES.map(benchCase => benchCase.id),
      chunkSize: 1,
    });
    const [first] = await claimScheduledChunks(env.BENCH_DB, schedulerConfig(SLOTS), NOW, 'claim');
    if (!first) throw new Error('Expected the first chunk to be claimed');
    claim = first;
    delivery = {
      runId: RUN_ID,
      kind: 'decider',
      model: claim.model,
      claimId: claim.id,
      claimToken: claim.token,
    };
    const benchCase = DECIDER_CASES.find(c => c.id === JSON.parse(claim.case_ids)[0]);
    if (benchCase?.check.kind !== 'exact') throw new Error('Expected an exactly graded case');
    answer = benchCase.check.value;
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function storedChunk(id: string) {
    return sqlite.prepare('SELECT status, token, slot FROM scheduler_chunks WHERE id = ?').get(id);
  }

  function laneFailures() {
    return sqlite.prepare('SELECT model, variant, rep, chunk FROM run_lane_failures').all();
  }

  function caseResults() {
    return sqlite
      .prepare('SELECT model, case_id, score, latency_ms, exit_code FROM case_results')
      .all();
  }

  async function cancelDuringPaidCase() {
    void processJob(env, delivery);
    await runStarted.promise;
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM scheduler_executions').get()?.n).toBe(1);
  }

  async function redeliverAt(time: number) {
    vi.setSystemTime(time);
    sent = [];
    await processJob(env, delivery);
  }

  function expectQuarantined(delaySeconds: number) {
    expect(laneFailures()).toEqual([]);
    expect(storedChunk(claim.id)).toEqual({
      status: 'active',
      token: claim.token,
      slot: claim.slot,
    });
    expect(sent).toEqual([{ body: delivery, delaySeconds }]);
    expect(runRequests).toHaveLength(1);
  }

  it('resumes on redelivery and reuses the outcome the container posts later', async () => {
    await cancelDuringPaidCase();

    await redeliverAt(NOW + 30_000);
    expectQuarantined(30);

    const { resultCallback } = await runRequests[0].json<{
      resultCallback: { execution: unknown };
    }>();
    await expect(
      acceptContainerCaseResult(env, {
        execution: resultCallback.execution,
        outcome: {
          kind: 'completed',
          response: {
            exitCode: 0,
            durationMs: 4_000,
            stdoutLines: [
              JSON.stringify({ type: 'text', part: { text: answer, time: { end: 1 } } }),
            ],
            stderrTail: '',
          },
        },
      })
    ).resolves.toBe(true);

    await redeliverAt(NOW + 60_000);
    expect(caseResults()).toEqual([
      {
        model: claim.model,
        case_id: JSON.parse(claim.case_ids)[0],
        score: 1,
        latency_ms: 4_000,
        exit_code: 0,
      },
    ]);
    expect(laneFailures()).toEqual([]);
    expect(storedChunk(claim.id)).toEqual({ status: 'completed', token: claim.token, slot: null });
    expect(runRequests).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([
      { body: expect.objectContaining({ runId: RUN_ID, claimId: expect.any(String) }) },
    ]);
    expect(sent[0]?.body.claimId).not.toBe(claim.id);
  });

  it('fails the lane only once the output deadline passes with nothing posted', async () => {
    await cancelDuringPaidCase();

    await redeliverAt(NOW + 30_000);
    expectQuarantined(30);

    await redeliverAt(NOW + PAID_OUTPUT_WAIT_MS - 1_000);
    expectQuarantined(1);

    await redeliverAt(NOW + PAID_OUTPUT_WAIT_MS);
    expect(laneFailures()).toEqual([
      { model: claim.model, variant: claim.variant, rep: claim.rep, chunk: claim.chunk },
    ]);
    expect(storedChunk(claim.id)).toEqual({ status: 'failed', token: claim.token, slot: null });
    expect(caseResults()).toEqual([]);
    expect(runRequests).toHaveLength(1);
    expect(sent).toEqual([
      { body: expect.objectContaining({ runId: RUN_ID, claimId: expect.any(String) }) },
    ]);
    expect(sent[0]?.body.model).not.toBe(claim.model);
  });
});
