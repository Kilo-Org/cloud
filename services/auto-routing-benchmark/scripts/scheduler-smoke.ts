import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import {
  beginPaidCase,
  claimScheduledChunks,
  finishChunk,
  scheduleRunChunks,
  schedulerConfig,
  startChunk,
  type SchedulerClaim,
} from '../src/scheduler';

const exec = promisify(execFile);
const directory = await mkdtemp(join(tmpdir(), 'scheduler-smoke-'));
const sqlite = new DatabaseSync(join(directory, 'scheduler.sqlite'));
const db = sqliteD1(sqlite);
const config = schedulerConfig(
  JSON.stringify({
    slots: 5,
    modelConcurrency: 1,
    providerConcurrency: 2,
  })
);
const startedAt = Date.now();
const events: { event: string; run: string; slot: number; elapsedMs: number }[] = [];
let peak = 0;
let borrowed = false;
let reusedBeforeSlowFinished = false;
let completed = 0;

try {
  applyBenchmarkMigrations(sqlite);
  for (const [id, router, purpose, provider, count] of [
    ['slow', 'efficient', 'platform', 'deepinfra', 3],
    ['fast', 'frontier', 'platform', 'fireworks', 3],
    ['owner', 'efficient', 'user', 'together', 8],
  ] as const) {
    sqlite
      .prepare(`INSERT INTO benchmark_runs (
      id, router, kind, purpose, status, started_at, min_accuracy, switch_cost_factor,
      max_concurrency, repetitions, engine_identity
    ) VALUES (?, ?, 'decider', ?, 'running', ?, 0.7, 3, 0, 1, 'scheduler-smoke')`)
      .run(id, router, purpose, new Date(startedAt).toISOString());
    await scheduleRunChunks(db, {
      runId: id,
      entries: Array.from({ length: count }, (_, index) => ({
        model: `${id}-${index}`,
        variant: null,
        providers: [provider],
      })),
      repetitions: 1,
      caseIds: ['compute-a', 'compute-b'],
      chunkSize: 1,
    });
  }

  const active = new Map<string, Promise<void>>();
  function observe() {
    const live = sqlite
      .prepare(`SELECT chunk.*, run.purpose FROM scheduler_chunks AS chunk
      JOIN benchmark_runs AS run ON run.id = chunk.run_id WHERE chunk.status IN ('queued', 'active')`)
      .all();
    assert(live.length <= config.slots);
    assert.equal(new Set(live.map(row => row.slot)).size, live.length);
    for (const provider of ['deepinfra', 'fireworks', 'together']) {
      assert(live.filter(row => JSON.parse(String(row.providers)).includes(provider)).length <= 2);
    }
    assert.equal(new Set(live.map(row => row.model)).size, live.length);
    peak = Math.max(peak, live.length);
    if (live.filter(row => row.purpose === 'user').length > 1) borrowed = true;
  }

  async function execute(claim: SchedulerClaim) {
    assert(await startChunk(db, claim.id, claim.token, Date.now()));
    const caseIds: string[] = JSON.parse(claim.case_ids);
    const caseId = caseIds[0];
    assert(caseId);
    assert(
      await beginPaidCase(db, {
        runId: claim.run_id,
        model: claim.model,
        variant: claim.variant,
        rep: claim.rep,
        caseId,
        token: claim.token,
      })
    );
    assert.equal(await startChunk(db, claim.id, claim.token, Date.now()), false);
    events.push({
      event: 'start',
      run: claim.run_id,
      slot: claim.slot,
      elapsedMs: Date.now() - startedAt,
    });
    const iterations = claim.run_id === 'slow' ? 1_500_000 : 20_000;
    const result = await exec(process.execPath, [
      '-e',
      `process.stdout.write(require('node:crypto').pbkdf2Sync('scheduler-workload','isolated-fixture',${iterations},32,'sha512').toString('hex'))`,
    ]);
    assert.match(result.stdout, /^[0-9a-f]{64}$/);
    await finishChunk(db, claim.id, claim.token);
    completed++;
    events.push({
      event: 'finish',
      run: claim.run_id,
      slot: claim.slot,
      elapsedMs: Date.now() - startedAt,
    });
    active.delete(claim.id);
    observe();
  }

  while (true) {
    const claimed = await claimScheduledChunks(db, config, Date.now(), crypto.randomUUID());
    for (const claim of claimed) {
      if (
        claim.run_id !== 'slow' &&
        events.some(event => event.event === 'finish' && event.run !== 'slow') &&
        sqlite
          .prepare("SELECT 1 FROM scheduler_chunks WHERE run_id = 'slow' AND status = 'active'")
          .get()
      ) {
        reusedBeforeSlowFinished = true;
      }
      const job = execute(claim);
      active.set(claim.id, job);
      observe();
    }
    if (active.size === 0) break;
    await Promise.race(active.values());
  }
  assert.equal(completed, 28);
  assert.equal(peak, 5);
  assert(borrowed, 'Unused share must be borrowed');
  assert(reusedBeforeSlowFinished, 'A freed fast slot must refill while slow work is still active');
  assert.equal(
    sqlite.prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE status != 'completed'").get()
      ?.n,
    0
  );
  assert.equal(
    sqlite.prepare('SELECT COUNT(*) AS n FROM scheduler_executions').get()?.n,
    completed
  );
  const initial = events.filter(event => event.event === 'start').slice(0, 5);
  assert.deepEqual(
    initial.reduce<Record<string, number>>((counts, event) => {
      counts[event.run] = (counts[event.run] ?? 0) + 1;
      return counts;
    }, {}),
    { fast: 2, owner: 1, slow: 2 }
  );
  sqlite
    .prepare(
      "UPDATE benchmark_runs SET status = 'completed', completed_at = ? WHERE status = 'running'"
    )
    .run(new Date(startedAt).toISOString());
  sqlite
    .prepare(`INSERT INTO benchmark_runs (
      id, router, kind, purpose, status, started_at, min_accuracy, switch_cost_factor,
      max_concurrency, repetitions, engine_identity
    ) VALUES ('backlog', 'efficient', 'decider', 'platform', 'running', ?, 0.7, 3, 0, 1, 'scheduler-smoke')`)
    .run(new Date(startedAt).toISOString());
  await scheduleRunChunks(db, {
    runId: 'backlog',
    entries: Array.from({ length: 200 }, (_, index) => ({
      model: `backlog-${index}`,
      variant: null,
      providers: [`backlog-provider-${index}`],
    })),
    repetitions: 1,
    caseIds: Array.from({ length: 60 }, (_, index) => `backlog-case-${index}`),
    chunkSize: 1,
  });
  const backlogPending = sqlite
    .prepare("SELECT COUNT(*) AS n FROM scheduler_chunks WHERE run_id = 'backlog'")
    .get()?.n;
  assert.equal(backlogPending, 12_000);
  const backlogStarted = Date.now();
  const backlogClaims = await claimScheduledChunks(db, config, Date.now(), crypto.randomUUID());
  const backlogMs = Date.now() - backlogStarted;
  assert.equal(backlogClaims.length, 5);
  assert(backlogMs < 2_000, `Dispatch over ${backlogPending} pending chunks took ${backlogMs}ms`);
  console.log(
    JSON.stringify(
      {
        storage: 'real SQLite, full production migrations',
        workload: 'real child-process PBKDF2, no model endpoints',
        completed,
        peak,
        borrowed,
        reusedBeforeSlowFinished,
        elapsedMs: Date.now() - startedAt,
        backlogPending,
        backlogClaims: backlogClaims.length,
        backlogMs,
        events,
      },
      null,
      2
    )
  );
} finally {
  sqlite.close();
  await rm(directory, { recursive: true, force: true });
}
