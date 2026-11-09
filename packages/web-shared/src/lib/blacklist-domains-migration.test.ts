import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { blacklisted_domains, domain_blacklist_state } from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { initializeDomainBlacklist } from '@kilocode/web-shared/lib/blacklist-domains-migration';
import type { BlacklistDomainsConfig } from '@kilocode/worker-utils/account-access';
import { sql } from 'drizzle-orm';

beforeEach(async () => {
  await db.delete(domain_blacklist_state).where(sql`true`);
  await db.delete(blacklisted_domains).where(sql`true`);
});

const legacy = (domains: string[], fields = {}) =>
  JSON.stringify({
    domains,
    updated_at: 'legacy-version',
    updated_by: null,
    updated_by_email: null,
    ...fields,
  });

describe('domain blacklist initialization', () => {
  test('preserves PostgreSQL domains and saves only legacy settings', async () => {
    const postgresDomains = ['postgres.example', 'postgres-stale-extra.example'];
    const raw = legacy(['legacy-only.example', 'legacy-stale-extra.example'], {
      blocked_signup_tlds: [],
      updated_by: 'operator',
      updated_by_email: 'admin@example.com',
    });
    const read = jest.fn<() => Promise<string | null>>().mockResolvedValue(raw);
    const write = jest
      .fn<(settings: BlacklistDomainsConfig) => Promise<void>>()
      .mockResolvedValue(undefined);
    await db.insert(blacklisted_domains).values(postgresDomains.map(domain => ({ domain })));
    await initializeDomainBlacklist(db, read, write);
    expect((await db.select().from(blacklisted_domains)).map(row => row.domain).sort()).toEqual(
      postgresDomains.sort()
    );
    expect(write).toHaveBeenCalledWith({
      domains: [],
      blocked_signup_tlds: [],
      updated_at: 'legacy-version',
      updated_by: 'operator',
      updated_by_email: 'admin@example.com',
    });
    const [state] = await db.select().from(domain_blacklist_state);
    expect(state.use_env_fallback).toBe(false);
    expect(read).toHaveBeenCalledTimes(2);
    await expect(initializeDomainBlacklist(db, read, write)).rejects.toThrow('already initialized');
    expect(read).toHaveBeenCalledTimes(2);
  });

  test.each([null, legacy([]), legacy(['legacy.example'])])(
    'an empty PostgreSQL table enables deployment fallbacks regardless of legacy domains (%s)',
    async raw => {
      const write = jest
        .fn<(settings: BlacklistDomainsConfig) => Promise<void>>()
        .mockResolvedValue(undefined);
      await initializeDomainBlacklist(db, async () => raw, write);
      expect(await db.select().from(blacklisted_domains)).toEqual([]);
      const [state] = await db.select().from(domain_blacklist_state);
      expect(state.use_env_fallback).toBe(true);
      expect(write).toHaveBeenCalledWith(expect.objectContaining({ domains: [] }));
    }
  );

  test('a failed Redis source read never marks the blacklist initialized', async () => {
    await expect(
      initializeDomainBlacklist(
        db,
        async () => {
          throw new Error('Redis timeout');
        },
        async () => {}
      )
    ).rejects.toThrow('Redis timeout');
    expect(await db.select().from(domain_blacklist_state)).toEqual([]);
  });

  test.each(['{bad json', '', legacy(['legacy.example'], { updated_by: 42 })])(
    'invalid legacy payload %j leaves PostgreSQL unchanged',
    async raw => {
      const postgresDomains = ['postgres.example', 'postgres-extra.example'];
      await db.insert(blacklisted_domains).values(postgresDomains.map(domain => ({ domain })));
      await expect(
        initializeDomainBlacklist(
          db,
          async () => raw,
          async () => {}
        )
      ).rejects.toThrow();
      expect((await db.select().from(blacklisted_domains)).map(row => row.domain).sort()).toEqual(
        postgresDomains.sort()
      );
      expect(await db.select().from(domain_blacklist_state)).toEqual([]);
    }
  );

  test('a settings write failure leaves PostgreSQL domains and readiness unchanged', async () => {
    await db.insert(blacklisted_domains).values({ domain: 'preexisting.example' });
    await expect(
      initializeDomainBlacklist(
        db,
        async () => legacy(['legacy.example']),
        async () => {
          throw new Error('Redis write failed');
        }
      )
    ).rejects.toThrow('Redis write failed');
    expect(await db.select().from(blacklisted_domains)).toEqual([
      { domain: 'preexisting.example' },
    ]);
    expect(await db.select().from(domain_blacklist_state)).toEqual([]);
  });

  test('an existing readiness state refuses initialization before reading legacy data', async () => {
    const read = jest.fn<() => Promise<string | null>>().mockResolvedValue(legacy([]));
    await db.insert(blacklisted_domains).values({ domain: 'preexisting.example' });
    await db.insert(domain_blacklist_state).values({ use_env_fallback: false });
    await expect(initializeDomainBlacklist(db, read, async () => {})).rejects.toThrow(
      'already initialized'
    );
    expect(read).not.toHaveBeenCalled();
    expect(await db.select().from(blacklisted_domains)).toEqual([
      { domain: 'preexisting.example' },
    ]);
  });

  test('concurrent legacy edits abort without changing PostgreSQL domains or readiness', async () => {
    const postgresDomains = ['preexisting.example', 'keep-extra.example'];
    await db.insert(blacklisted_domains).values(postgresDomains.map(domain => ({ domain })));
    const read = jest
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(legacy(['first.example']))
      .mockResolvedValueOnce(legacy(['first.example', 'second.example']));
    const write = jest.fn<(settings: BlacklistDomainsConfig) => Promise<void>>();
    await expect(initializeDomainBlacklist(db, read, write)).rejects.toThrow('changed');
    expect((await db.select().from(blacklisted_domains)).map(row => row.domain).sort()).toEqual(
      postgresDomains.sort()
    );
    expect(await db.select().from(domain_blacklist_state)).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });

  test('reads its source after acquiring the same lock used by prep writers', async () => {
    let raw = legacy(['before.example']);
    const read = jest.fn<() => Promise<string | null>>().mockImplementation(async () => raw);
    await db.insert(blacklisted_domains).values({ domain: 'postgres.example' });
    let migration = Promise.resolve();
    try {
      await db.transaction(async tx => {
        await tx.execute(sql`LOCK TABLE ${blacklisted_domains} IN EXCLUSIVE MODE`);
        migration = initializeDomainBlacklist(db, read, async () => {});
        expect(read).not.toHaveBeenCalled();
        raw = legacy(['after.example']);
      });
    } finally {
      await migration;
    }
    expect(await db.select().from(blacklisted_domains)).toEqual([{ domain: 'postgres.example' }]);
    const [state] = await db.select().from(domain_blacklist_state);
    expect(state.use_env_fallback).toBe(false);
  });
});
