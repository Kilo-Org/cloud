import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_POOL_ENTRIES, type AutoRouter } from '@kilocode/auto-routing-contracts';
import { applyBenchmarkMigrations, sqliteD1 } from '../test/sqlite-d1';
import { PROFILE_ADMISSION_LIMIT, ProfileQuotaExceededError, registerProfiles } from './profiles';

const NOW = new Date('2026-10-16T12:00:00.000Z');
const owner = { ownerType: 'org' as const, ownerId: 'org-1' };

describe('platform-paid admission quota (real SQLite)', () => {
  let sqlite: DatabaseSync;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new DatabaseSync(':memory:');
    applyBenchmarkMigrations(sqlite);
    db = sqliteD1(sqlite);
  });

  const admit = (router: AutoRouter, models: string[], ownerId = owner.ownerId) =>
    registerProfiles(
      db,
      { router, deciderRepetitions: 1 },
      {
        ownerType: owner.ownerType,
        ownerId,
        pairs: models.map(model => ({ model, variant: null })),
        now: NOW,
      }
    );

  const models = (prefix: string, count: number) =>
    Array.from({ length: count }, (_, i) => `${prefix}/m-${i}`);

  it('allows the limit per base router and rejects one more on that router only', async () => {
    const efficient = models('efficient', PROFILE_ADMISSION_LIMIT);
    for (let offset = 0; offset < efficient.length; offset += MAX_POOL_ENTRIES) {
      await admit('efficient', efficient.slice(offset, offset + MAX_POOL_ENTRIES));
    }
    await expect(admit('efficient', ['efficient/one-more'])).rejects.toBeInstanceOf(
      ProfileQuotaExceededError
    );

    const frontier = await admit('frontier', ['frontier/first']);
    expect(frontier.statuses).toEqual([
      { entry: { model: 'frontier/first', variant: null }, status: 'pending', failureReason: null },
    ]);
    expect(
      sqlite
        .prepare(
          'SELECT router, COUNT(*) AS n FROM profile_request_events GROUP BY router ORDER BY router'
        )
        .all()
    ).toEqual([
      { router: 'efficient', n: PROFILE_ADMISSION_LIMIT },
      { router: 'frontier', n: 1 },
    ]);
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM benchmark_profiles WHERE router = 'frontier'").get()
    ).toEqual({ n: 1 });
  });

  it('charges nothing for models another owner already has pending or ready', async () => {
    await admit('frontier', ['shared/pending', 'shared/ready'], 'org-2');
    sqlite.exec("UPDATE benchmark_profiles SET status = 'ready' WHERE model = 'shared/ready'");
    sqlite.exec('DELETE FROM profile_request_events');

    const result = await admit('frontier', ['shared/pending', 'shared/ready']);
    expect(result.statuses.map(s => s.status)).toEqual(['pending', 'ready']);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
      n: 0,
    });
  });

  it('admits only the remaining capacity when concurrent requests race at the limit', async () => {
    const filled = models('filled', PROFILE_ADMISSION_LIMIT - 1);
    for (let offset = 0; offset < filled.length; offset += MAX_POOL_ENTRIES) {
      await admit('efficient', filled.slice(offset, offset + MAX_POOL_ENTRIES));
    }

    const results = await Promise.allSettled([
      admit('efficient', ['race/a']),
      admit('efficient', ['race/b']),
    ]);

    expect(results.map(result => result.status).toSorted()).toEqual(['fulfilled', 'rejected']);
    const rejected = results.find(result => result.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(ProfileQuotaExceededError);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM profile_request_events').get()).toEqual({
      n: PROFILE_ADMISSION_LIMIT,
    });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS n FROM benchmark_profiles WHERE model LIKE 'race/%'").get()
    ).toEqual({ n: 1 });
  });
});
