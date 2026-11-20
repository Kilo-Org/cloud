import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import {
  backfillDayLedger,
  evaluateRunClaim,
  readRunSpendState,
  readSpendTotals,
  utcDayOf,
} from './spend';

const CAPS = { perRunUsd: 50, perDayUsd: 150, perOwnerDayUsd: 25 };
const DAY = '2026-11-20';
const RUN = 'decider-2026-11-20T01-00-00-000Z-aaaaaaaa';
const MODEL = 'vendor/model';
const CASE = 'supp-agent-term-pwd-base';

/** A run row as it exists after the cap deploys: running, no spend columns set. */
function insertRun(
  db: DatabaseSync,
  overrides: {
    id?: string;
    status?: string;
    spentUsd?: number;
    pauseScope?: string | null;
    ownerType?: string | null;
    ownerId?: string | null;
  } = {}
) {
  db.prepare(
    `INSERT INTO benchmark_runs (id, router, kind, status, started_at, min_accuracy,
      switch_cost_factor, max_concurrency, repetitions, engine_identity, purpose,
      measurement_revision, spent_usd, spend_pause_scope, spend_owner_type, spend_owner_id)
    VALUES (?, 'efficient', 'decider', ?, '2026-11-20T01:00:00.000Z', 0.7, 3, 0, 3,
      'efficient:v1:abc', 'platform', 3, ?, ?, ?, ?)`
  ).run(
    overrides.id ?? RUN,
    overrides.status ?? 'running',
    overrides.spentUsd ?? 0,
    overrides.pauseScope ?? null,
    overrides.ownerType ?? null,
    overrides.ownerId ?? null
  );
}

/**
 * A result whose paid execution started this day, which is what the ledger
 * backfill counts: the join to `scheduler_executions` is the freshness rule.
 */
function insertFreshResult(
  db: DatabaseSync,
  params: {
    runId?: string;
    costUsd: number | null;
    startedAt: number;
    caseId?: string;
    model?: string;
    variant?: string;
  }
) {
  const runId = params.runId ?? RUN;
  const caseId = params.caseId ?? CASE;
  const model = params.model ?? MODEL;
  const variant = params.variant ?? '';
  db.prepare(
    `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score,
      latency_ms, cost_usd, rep, timed_out, prompt_revision)
    VALUES (?, ?, ?, ?, 'debugging/debugging', 1, 10, ?, 0, 0, 3)`
  ).run(runId, model, variant, caseId, params.costUsd);
  db.prepare(
    `INSERT INTO scheduler_executions (run_id, model, variant, rep, case_id, token,
      started_at, prompt_revision)
    VALUES (?, ?, ?, 0, ?, 'token', ?, 3)`
  ).run(runId, model, variant, caseId, params.startedAt);
}

const dayStart = () => Date.parse(`${DAY}T09:00:00.000Z`);

describe('benchmark spend ledger and caps', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
  });

  it('counts only the day requested, ignoring a result executed the day before', async () => {
    insertRun(sqlite);
    insertFreshResult(sqlite, { costUsd: 4, startedAt: dayStart(), caseId: 'case-today' });
    insertFreshResult(sqlite, {
      costUsd: 90,
      startedAt: Date.parse('2026-11-19T23:59:00.000Z'),
      caseId: 'case-yesterday',
    });

    await backfillDayLedger(db, DAY);
    const totals = await readSpendTotals(db, DAY);

    expect(totals.dayUsd).toBeCloseTo(4, 6);
  });

  it('seeds the ledger once per day, so a second call cannot double the total', async () => {
    insertRun(sqlite);
    insertFreshResult(sqlite, { costUsd: 7.25, startedAt: dayStart() });

    await backfillDayLedger(db, DAY);
    await backfillDayLedger(db, DAY);
    // A parallel first tick that raced the guard: the aggregate still may not add.
    await backfillDayLedger(db, DAY);

    const rows = sqlite
      .prepare('SELECT COUNT(*) AS n, SUM(spent_usd) AS total FROM benchmark_spend_ledger')
      .get() as { n: number; total: number };
    expect(rows.n).toBe(1);
    expect(rows.total).toBeCloseTo(7.25, 6);
  });

  it('pauses a run that was already running when the cap went live, and claims nothing', async () => {
    // The day is already far over the cap before this run's first dispatch pass.
    insertRun(sqlite);
    insertFreshResult(sqlite, { costUsd: 900, startedAt: dayStart(), caseId: 'case-prior' });

    const seeded = await readSpendTotals(db, DAY);
    expect(seeded.dayUsd).toBeGreaterThan(CAPS.perDayUsd);

    // The pause pass dispatch runs before any claim: every running, unpaused run.
    const paused = sqlite
      .prepare(
        `UPDATE benchmark_runs SET spend_pause_scope = 'day'
         WHERE status = 'running' AND spend_pause_scope IS NULL RETURNING id`
      )
      .all() as Array<{ id: string }>;
    expect(paused.map(row => row.id)).toEqual([RUN]);

    // The claim-time predicate the lane-head query applies.
    const claimable = sqlite
      .prepare(
        `SELECT id FROM benchmark_runs
         WHERE status = 'running' AND spend_pause_scope IS NULL AND spent_usd < ?`
      )
      .all(CAPS.perRunUsd) as Array<{ id: string }>;
    expect(claimable).toEqual([]);

    const state = await readRunSpendState(db, RUN);
    expect(state?.paused).toBe(true);
    expect(state?.pauseScope).toBe('day');
  });

  it('stops a run at its own per-run cap even before the pause row is written', async () => {
    insertRun(sqlite, { spentUsd: CAPS.perRunUsd });
    const claimable = sqlite
      .prepare(
        `SELECT id FROM benchmark_runs
         WHERE status = 'running' AND spend_pause_scope IS NULL AND spent_usd < ?`
      )
      .all(CAPS.perRunUsd) as Array<{ id: string }>;
    expect(claimable).toEqual([]);

    const decision = await evaluateRunClaim(db, { runId: RUN, caps: CAPS });
    expect(decision).toMatchObject({ allow: false, scope: 'run' });
    const state = await readRunSpendState(db, RUN);
    expect(state?.pauseScope).toBe('run');
  });

  it('resumes a paused run only once a raised cap leaves room', async () => {
    insertRun(sqlite, { pauseScope: 'run', spentUsd: 60 });
    const blocked = await evaluateRunClaim(db, { runId: RUN, caps: CAPS });
    expect(blocked.allow).toBe(false);

    const raised = await evaluateRunClaim(db, {
      runId: RUN,
      caps: { ...CAPS, perRunUsd: 100 },
    });
    expect(raised.allow).toBe(true);
    expect((await readRunSpendState(db, RUN))?.paused).toBe(false);
  });

  it('attributes a pre-cap run to the platform row, since such a run has no owner', async () => {
    insertRun(sqlite);
    insertFreshResult(sqlite, { costUsd: 12, startedAt: dayStart() });
    await backfillDayLedger(db, DAY);

    const row = sqlite
      .prepare(
        `SELECT owner_type, owner_id, spent_usd FROM benchmark_spend_ledger WHERE day = ?`
      )
      .all(DAY) as Array<{ owner_type: string; owner_id: string; spent_usd: number }>;
    expect(row).toHaveLength(1);
    expect(row[0]).toMatchObject({ owner_type: '', owner_id: '' });
    expect(row[0].spent_usd).toBeCloseTo(12, 6);
  });

  it('does not count a reused copy: a result with no paid execution this day', async () => {
    insertRun(sqlite);
    // A reuse copy carries the source row's cost but has no scheduler_executions row,
    // because nothing was paid for it.
    sqlite
      .prepare(
        `INSERT INTO case_results (run_id, model, variant, case_id, route_key, score,
          latency_ms, cost_usd, rep, timed_out, prompt_revision)
        VALUES (?, ?, '', 'reused-case', 'debugging/debugging', 1, 10, 55, 0, 0, 3)`
      )
      .run(RUN, MODEL);

    await backfillDayLedger(db, DAY);

    const total = sqlite
      .prepare('SELECT COALESCE(SUM(spent_usd), 0) AS total FROM benchmark_spend_ledger')
      .get() as { total: number };
    expect(total.total).toBe(0);
  });

  it('reports UTC day boundaries, not local ones', () => {
    expect(utcDayOf(new Date('2026-11-20T23:59:59.999Z'))).toBe('2026-11-20');
    expect(utcDayOf(new Date('2026-11-21T00:00:00.000Z'))).toBe('2026-11-21');
  });
});
