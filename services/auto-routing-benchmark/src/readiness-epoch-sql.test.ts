import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { applyBenchmarkMigrations } from '../test/sqlite-d1';

/**
 * The readiness epoch is what makes the serving Worker see a settlement on its next request, so
 * these assertions pin which storage writes may advance it. They run against the real migration
 * set (trigger included), not a hand-written table, so a future edit that widens or narrows the
 * trigger fails here instead of after a deploy.
 */
describe('benchmark readiness epoch trigger (real migrations)', () => {
  let sqlite: DatabaseSync;

  const epoch = (router: 'efficient' | 'frontier' = 'efficient'): number => {
    const row = sqlite
      .prepare('SELECT epoch FROM benchmark_readiness_epoch WHERE router = ?')
      .get(router) as { epoch: number } | undefined;
    if (!row) throw new Error(`no epoch row for ${router}`);
    return row.epoch;
  };

  const insertProfile = (row: {
    model?: string;
    variant?: string;
    status: string;
    runId?: string | null;
    completedAt?: string;
    failureAttempts?: number;
    retryAfter?: string | null;
    platformRequested?: number;
  }) => {
    sqlite
      .prepare(
        `INSERT INTO benchmark_profiles (router, model, variant, engine_identity, repetitions,
          status, run_id, requested_at, updated_at, completed_at, platform_requested,
          user_requested, failure_attempts, retry_after)
         VALUES ('efficient', ?, ?, 'efficient:v3:test', 3, ?, ?, '2026-01-01', '2026-01-01',
           ?, ?, 0, ?, ?)`
      )
      .run(
        row.model ?? 'vendor/model',
        row.variant ?? '',
        row.status,
        row.runId ?? null,
        row.completedAt ?? '2026-01-01',
        row.platformRequested ?? 1,
        row.failureAttempts ?? 0,
        row.retryAfter ?? null
      );
  };

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
  });

  it('seeds one row per base router at zero', () => {
    expect(epoch('efficient')).toBe(0);
    expect(epoch('frontier')).toBe(0);
  });

  it('does not bump on claim, requeue, or failure bookkeeping between non-serving states', () => {
    insertProfile({ status: 'pending' });
    expect(epoch()).toBe(0);

    // Claim, then requeue, then retry bookkeeping: none of these can change a published table.
    sqlite.exec(
      "UPDATE benchmark_profiles SET status = 'running', run_id = 'run-claim' WHERE model = 'vendor/model'"
    );
    expect(epoch()).toBe(0);
    sqlite.exec(
      "UPDATE benchmark_profiles SET status = 'pending', run_id = NULL WHERE model = 'vendor/model'"
    );
    expect(epoch()).toBe(0);
    sqlite.exec(
      `UPDATE benchmark_profiles SET status = 'failed', failure_class = 'provider_unavailable',
        failure_attempts = 2, retry_after = '2026-05-01' WHERE model = 'vendor/model'`
    );
    expect(epoch()).toBe(0);
    sqlite.exec(
      "UPDATE benchmark_profiles SET failure_attempts = 3, retry_after = '2026-06-01' WHERE model = 'vendor/model'"
    );
    expect(epoch()).toBe(0);
  });

  it('bumps when a pair becomes ready', () => {
    insertProfile({ status: 'running', runId: 'run-1' });
    expect(epoch()).toBe(0);
    sqlite.exec(
      `UPDATE benchmark_profiles SET status = 'ready', completed_at = '2026-04-01'
       WHERE model = 'vendor/model'`
    );
    expect(epoch()).toBe(1);
  });

  it('bumps when a serving pair loses its measurement identity or readiness', () => {
    insertProfile({ status: 'ready', runId: 'run-1', completedAt: '2026-04-01' });
    expect(epoch()).toBe(1);

    // A new measurement for the same pair (a re-run swaps the provenance run).
    sqlite.exec(
      "UPDATE benchmark_profiles SET run_id = 'run-2', completed_at = '2026-05-01' WHERE model = 'vendor/model'"
    );
    expect(epoch()).toBe(2);

    // Readiness lost.
    sqlite.exec(
      "UPDATE benchmark_profiles SET status = 'unavailable', failure_class = 'catalog_absent' WHERE model = 'vendor/model'"
    );
    expect(epoch()).toBe(3);
  });

  it('bumps when a serving pair is inserted or removed', () => {
    insertProfile({ model: 'vendor/ready', status: 'ready', runId: 'run-ready' });
    expect(epoch()).toBe(1);
    sqlite.exec("DELETE FROM benchmark_profiles WHERE model = 'vendor/ready'");
    expect(epoch()).toBe(2);

    // A row inserted already failed is not serving, so it changes no table.
    insertProfile({ model: 'vendor/dead', status: 'unavailable' });
    expect(epoch()).toBe(2);
  });

  const insertConfig = () => {
    sqlite.exec(
      `INSERT INTO benchmark_config (id, router, min_accuracy, switch_cost_factor,
        max_concurrency, updated_at, updated_by, accuracy_noise_band)
       VALUES (1, 'efficient', 0.7, 3, 4, '2026-01-01', 'admin-a', 0.05)`
    );
  };

  it('bumps on a saved policy change without touching any profile', () => {
    insertConfig();
    const before = epoch();
    sqlite.exec(
      `UPDATE benchmark_config SET policy_overrides = '{"minAccuracy":0.8}'
       WHERE router = 'efficient'`
    );
    expect(epoch()).toBe(before + 1);

    // The daily system-optimal computation changes the same effective policy.
    sqlite.exec(
      `UPDATE benchmark_config SET policy_computed = '{"minAccuracy":{"value":0.85}}'
       WHERE router = 'efficient'`
    );
    expect(epoch()).toBe(before + 2);
  });

  it('leaves the epoch alone for an audit-only or identical policy save', () => {
    insertConfig();
    sqlite.exec(
      `UPDATE benchmark_config SET policy_overrides = '{"minAccuracy":0.8}'
       WHERE router = 'efficient'`
    );
    const afterPolicy = epoch();

    // Re-saving with only the audit columns different, or with the identical value, is a no-op for
    // serving: nothing about which candidate wins a route changed.
    sqlite.exec(
      `UPDATE benchmark_config SET updated_at = '2026-02-01', updated_by = 'admin-b',
        policy_overrides = '{"minAccuracy":0.8}' WHERE router = 'efficient'`
    );
    expect(epoch()).toBe(afterPolicy);
  });

  it('bumps both routers when a serving row is re-keyed', () => {
    insertProfile({ model: 'vendor/moved', status: 'ready', runId: 'run-moved' });
    expect(epoch('efficient')).toBe(1);

    // SQLite permits a primary-key update; the old and new router must both observe the change.
    sqlite.exec(
      `UPDATE benchmark_profiles SET router = 'frontier', model = 'vendor/moved-elsewhere'
       WHERE model = 'vendor/moved'`
    );
    expect(epoch('efficient')).toBe(2);
    expect(epoch('frontier')).toBe(1);
  });
});
