import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  recordBenchmarkSettlementOutcomes,
  recoverPendingBenchmarkSettlements,
} from './benchmark-settlement';
import type { ProfileCreditBridge } from './profile-billing';

const SCHEMA_SQL = `
  CREATE TABLE benchmark_runs (id TEXT PRIMARY KEY, status TEXT NOT NULL);
  CREATE TABLE benchmark_profiles (
    model TEXT NOT NULL, variant TEXT NOT NULL, engine_identity TEXT NOT NULL,
    repetitions INTEGER NOT NULL, status TEXT NOT NULL, run_id TEXT,
    PRIMARY KEY (model, variant, engine_identity, repetitions)
  );
  CREATE TABLE case_results (
    run_id TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL,
    case_id TEXT NOT NULL, rep INTEGER NOT NULL, cost_usd REAL,
    PRIMARY KEY (run_id, model, variant, case_id, rep)
  );
  CREATE TABLE profile_benchmark_admissions (
    admission_id TEXT PRIMARY KEY, owner_type TEXT NOT NULL, owner_id TEXT NOT NULL
  );
  CREATE TABLE profile_benchmark_claims (
    admission_id TEXT NOT NULL, model TEXT NOT NULL, variant TEXT NOT NULL,
    engine_identity TEXT NOT NULL, repetitions INTEGER NOT NULL,
    estimated_cost_usd REAL NOT NULL, charged_cost_usd REAL,
    quota_charged INTEGER NOT NULL DEFAULT 1,
    terminal_status TEXT, state TEXT NOT NULL, run_id TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, settled_at TEXT,
    PRIMARY KEY (admission_id, model, variant)
  );
  CREATE UNIQUE INDEX active_claim ON profile_benchmark_claims
    (model, variant, engine_identity, repetitions)
    WHERE state IN ('allocating', 'admitted') AND terminal_status IS NULL;
`;

type TestD1 = { db: D1Database; failNextSettlementWrite: () => void };

function createD1(sqlite: DatabaseSync) {
  let failSettlementWrite = false;
  const db = {
    prepare(query: string) {
      let params: unknown[] = [];
      const statement = {
        bind(...values: unknown[]) {
          params = values;
          return statement;
        },
        async run() {
          if (failSettlementWrite && query.includes('"settled_at"')) {
            failSettlementWrite = false;
            throw new Error('D1 unavailable after credit settlement');
          }
          const result = sqlite.prepare(query).run(...(params as never[]));
          return { success: true, results: [], meta: { changes: Number(result.changes) } };
        },
        async all() {
          return {
            success: true,
            results: sqlite.prepare(query).all(...(params as never[])),
            meta: {},
          };
        },
        async raw() {
          return sqlite
            .prepare(query)
            .all(...(params as never[]))
            .map(row => Object.values(row));
        },
      };
      return statement;
    },
  } as unknown as D1Database;
  return {
    db,
    failNextSettlementWrite() {
      failSettlementWrite = true;
    },
  };
}

type ClaimRow = {
  admission_id: string;
  model: string;
  variant: string;
  state: string;
  terminal_status: string | null;
  charged_cost_usd: number | null;
  settled_at: string | null;
};

describe('benchmark owner settlements', () => {
  let sqlite: DatabaseSync;
  let d1: TestD1;
  const settle = vi.fn<ProfileCreditBridge['settle']>();
  const billing = { settle };

  function exec(query: string, params: unknown[] = []) {
    sqlite.prepare(query).run(...(params as never[]));
  }

  function addClaim({
    admissionId = 'admission-1',
    runId = 'run-1',
    model = 'vendor/model',
    variant = '',
    status = 'ready',
    ownerType = 'user',
    ownerId = 'owner-1',
    engineIdentity = 'engine-1',
    repetitions = 1,
  }: {
    admissionId?: string;
    runId?: string;
    model?: string;
    variant?: string;
    status?: 'ready' | 'failed' | 'running';
    ownerType?: 'user' | 'org';
    ownerId?: string;
    engineIdentity?: string;
    repetitions?: number;
  } = {}) {
    exec('INSERT OR IGNORE INTO benchmark_runs VALUES (?, ?)', [runId, 'completed']);
    exec('INSERT OR IGNORE INTO profile_benchmark_admissions VALUES (?, ?, ?)', [
      admissionId,
      ownerType,
      ownerId,
    ]);
    exec(`INSERT OR REPLACE INTO benchmark_profiles VALUES (?, ?, ?, ?, ?, ?)`, [
      model,
      variant,
      engineIdentity,
      repetitions,
      status,
      runId,
    ]);
    exec(
      `INSERT INTO profile_benchmark_claims
       (admission_id, model, variant, engine_identity, repetitions, estimated_cost_usd,
        state, run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 10, 'admitted', ?, 'created', 'created')`,
      [admissionId, model, variant, engineIdentity, repetitions, runId]
    );
  }

  function addCost(
    cost: number | null,
    {
      runId = 'run-1',
      model = 'vendor/model',
      variant = '',
      rep = 0,
    }: { runId?: string; model?: string; variant?: string; rep?: number } = {}
  ) {
    exec('INSERT INTO case_results VALUES (?, ?, ?, ?, ?, ?)', [
      runId,
      model,
      variant,
      crypto.randomUUID(),
      rep,
      cost,
    ]);
  }

  function claims() {
    return sqlite
      .prepare(
        `SELECT admission_id, model, variant, state, terminal_status, charged_cost_usd, settled_at
         FROM profile_benchmark_claims ORDER BY admission_id, model, variant`
      )
      .all() as ClaimRow[];
  }

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    sqlite.exec(SCHEMA_SQL);
    d1 = createD1(sqlite);
    settle.mockReset().mockResolvedValue(undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    sqlite.close();
    vi.restoreAllMocks();
  });

  it('charges every ready exact pair its case costs across repetitions, not other pairs or runs', async () => {
    addClaim({ repetitions: 2, ownerType: 'org', ownerId: 'org-1' });
    addClaim({ variant: 'high', repetitions: 2, ownerType: 'org', ownerId: 'org-1' });
    addCost(0.1);
    addCost(0.2, { rep: 1 });
    addCost(null);
    addCost(0.8, { variant: 'high' });
    addCost(7, { runId: 'other-run' });
    addCost(9, { model: 'other/model' });

    await recoverPendingBenchmarkSettlements(d1.db, billing);

    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle.mock.calls.map(([request]) => request)).toEqual(
      expect.arrayContaining([
        {
          admissionId: 'admission-1',
          ownerType: 'org',
          ownerId: 'org-1',
          model: 'vendor/model',
          variant: null,
          runId: 'run-1',
          actualCostUsd: 0.1 + 0.2,
        },
        {
          admissionId: 'admission-1',
          ownerType: 'org',
          ownerId: 'org-1',
          model: 'vendor/model',
          variant: 'high',
          runId: 'run-1',
          actualCostUsd: 0.8,
        },
      ])
    );
    expect(claims().every(claim => claim.state === 'settled' && claim.settled_at !== null)).toBe(
      true
    );
  });

  it('releases a failed lane for zero despite partial nonzero case rows', async () => {
    addClaim();
    addClaim({ variant: 'high', status: 'failed' });
    addCost(0.3);
    addCost(4, { variant: 'high' });

    await recoverPendingBenchmarkSettlements(d1.db, billing, 'run-1');

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ variant: null, actualCostUsd: 0.3 })
    );
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ variant: 'high', actualCostUsd: 0 })
    );
    expect(claims().find(claim => claim.variant === 'high')).toMatchObject({
      terminal_status: 'failed',
      charged_cost_usd: 0,
      state: 'settled',
    });
  });

  it('releases all claims after full run failure, overriding an earlier ready snapshot', async () => {
    addClaim();
    addCost(5);
    exec("UPDATE benchmark_runs SET status = 'running'");
    await recordBenchmarkSettlementOutcomes(d1.db, 'run-1');
    expect(claims()[0].charged_cost_usd).toBe(5);
    exec("UPDATE benchmark_runs SET status = 'failed'");
    exec('DELETE FROM benchmark_profiles');

    await recoverPendingBenchmarkSettlements(d1.db, billing);

    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ actualCostUsd: 0 }));
    expect(claims()[0]).toMatchObject({
      terminal_status: 'failed',
      charged_cost_usd: 0,
      state: 'settled',
    });
  });

  it('snapshots before run completion without settling while running and never recomputes late rows', async () => {
    addClaim();
    addCost(0.4);
    exec("UPDATE benchmark_runs SET status = 'running'");
    await recordBenchmarkSettlementOutcomes(d1.db, 'run-1');
    await recoverPendingBenchmarkSettlements(d1.db, billing);
    expect(settle).not.toHaveBeenCalled();
    addCost(10);
    exec("UPDATE benchmark_runs SET status = 'completed'");

    await recoverPendingBenchmarkSettlements(d1.db, billing);

    expect(settle).toHaveBeenCalledWith(expect.objectContaining({ actualCostUsd: 0.4 }));
  });

  it('recovers a crash after terminal status before any settlement snapshot', async () => {
    addClaim();
    addCost(0.7);
    expect(claims()[0].terminal_status).toBeNull();

    await recoverPendingBenchmarkSettlements(d1.db, billing);

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ actualCostUsd: 0.7, runId: 'run-1' })
    );
    expect(claims()[0].state).toBe('settled');
  });

  it('preserves a failed snapshot through late rows and a new admission for the same pair', async () => {
    addClaim({ status: 'failed' });
    addCost(3);
    await recordBenchmarkSettlementOutcomes(d1.db, 'run-1');
    addClaim({ admissionId: 'admission-2', runId: 'run-2' });
    addCost(0.2, { runId: 'run-2' });
    addCost(12);

    await recoverPendingBenchmarkSettlements(d1.db, billing);

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ admissionId: 'admission-1', runId: 'run-1', actualCostUsd: 0 })
    );
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ admissionId: 'admission-2', runId: 'run-2', actualCostUsd: 0.2 })
    );
    expect(claims().map(claim => claim.state)).toEqual(['settled', 'settled']);
  });

  it('retries an unavailable bridge without discarding the terminal status or immutable charge', async () => {
    addClaim();
    addCost(0.9);
    settle.mockRejectedValueOnce(new Error('billing unavailable'));

    await recoverPendingBenchmarkSettlements(d1.db, billing);
    expect(claims()[0]).toMatchObject({
      state: 'admitted',
      terminal_status: 'ready',
      charged_cost_usd: 0.9,
      settled_at: null,
    });
    addCost(20);
    await recoverPendingBenchmarkSettlements(d1.db, billing);
    await recoverPendingBenchmarkSettlements(d1.db, billing);

    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle.mock.calls[1][0]).toEqual(settle.mock.calls[0][0]);
    expect(claims()[0].state).toBe('settled');
  });

  it('replays the identical bridge idempotency key after a crash following remote settlement', async () => {
    addClaim();
    addCost(0.6);
    d1.failNextSettlementWrite();

    await recoverPendingBenchmarkSettlements(d1.db, billing);
    expect(claims()[0].state).toBe('admitted');
    await recoverPendingBenchmarkSettlements(d1.db, billing);

    expect(settle).toHaveBeenCalledTimes(2);
    expect(settle.mock.calls[1][0]).toEqual(settle.mock.calls[0][0]);
    expect(claims()[0].state).toBe('settled');
  });

  it('settles independent claims even when another billing settlement fails', async () => {
    addClaim();
    addClaim({ variant: 'high' });
    settle.mockRejectedValueOnce(new Error('billing unavailable'));

    await recoverPendingBenchmarkSettlements(d1.db, billing);

    expect(settle).toHaveBeenCalledTimes(2);
    expect(
      claims()
        .map(claim => claim.state)
        .sort()
    ).toEqual(['admitted', 'settled']);
  });

  it('does not bill cached profiles without claims or claims belonging to a still-running profile', async () => {
    exec("INSERT INTO benchmark_runs VALUES ('cached-run', 'completed')");
    exec(
      "INSERT INTO benchmark_profiles VALUES ('cached/model', '', 'engine-1', 1, 'ready', 'cached-run')"
    );
    addClaim({ status: 'running' });

    await recoverPendingBenchmarkSettlements(d1.db, billing);

    expect(settle).not.toHaveBeenCalled();
    expect(claims()[0].terminal_status).toBeNull();
  });

  it('never snapshots another engine or repetition profile as this claim outcome', async () => {
    addClaim({ status: 'running' });
    exec(
      "INSERT INTO benchmark_profiles VALUES ('vendor/model', '', 'engine-2', 1, 'ready', 'run-1')"
    );
    exec(
      "INSERT INTO benchmark_profiles VALUES ('vendor/model', '', 'engine-1', 2, 'ready', 'run-1')"
    );

    await recoverPendingBenchmarkSettlements(d1.db, billing);

    expect(settle).not.toHaveBeenCalled();
    expect(claims()[0].terminal_status).toBeNull();
  });

  it('releases a reaped orphan claim when the process crashed before inserting the run', async () => {
    addClaim({ status: 'failed' });
    exec('DELETE FROM benchmark_runs');

    await recoverPendingBenchmarkSettlements(d1.db, billing);

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ runId: 'run-1', actualCostUsd: 0 })
    );
    expect(claims()[0]).toMatchObject({ state: 'settled', terminal_status: 'failed' });
  });

  it('scopes immediate settlement to the terminating run while scheduled recovery finds the rest', async () => {
    addClaim();
    addClaim({ admissionId: 'admission-2', runId: 'run-2', model: 'other/model' });
    addCost(0.1);
    addCost(0.2, { runId: 'run-2', model: 'other/model' });

    await recoverPendingBenchmarkSettlements(d1.db, billing, 'run-1');
    expect(settle).toHaveBeenCalledTimes(1);
    expect(claims().find(claim => claim.admission_id === 'admission-2')).toMatchObject({
      state: 'admitted',
      terminal_status: null,
    });
    await recoverPendingBenchmarkSettlements(d1.db, billing);

    expect(settle).toHaveBeenCalledTimes(2);
    expect(claims().every(claim => claim.state === 'settled')).toBe(true);
  });
});
