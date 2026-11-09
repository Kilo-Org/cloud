import { blacklisted_domains, domain_blacklist_state } from '@kilocode/db/schema';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';
import {
  emailDomainSuffixes,
  isEmailDomainBlacklisted,
  type DomainBlacklistCache,
} from './account-access';

type StateRow = { revision: string; useEnvFallback: boolean };

type CapturedQuery = {
  selection: unknown;
  table: unknown;
  condition: unknown;
  limit: number | null;
};

type FakeDbOptions = {
  state?: StateRow | null;
  stateError?: Error;
  domains?: readonly string[];
  domainsError?: Error;
  stateHang?: boolean;
  domainsHang?: boolean;
};

type QueryChain = {
  from: (table: unknown) => QueryChain;
  where: (condition: unknown) => QueryChain;
  limit: (count: number) => Promise<unknown[]>;
};

function createDb(options: FakeDbOptions = {}) {
  const state =
    options.state === undefined ? { revision: 'revision-1', useEnvFallback: false } : options.state;
  const queries: CapturedQuery[] = [];
  const db = {
    select: (selection: unknown) => {
      const query: CapturedQuery = {
        selection,
        table: undefined,
        condition: undefined,
        limit: null,
      };
      const chain: QueryChain = {
        from(table) {
          query.table = table;
          return chain;
        },
        where(condition) {
          query.condition = condition;
          return chain;
        },
        async limit(count) {
          query.limit = count;
          queries.push(query);
          if (query.condition === undefined) {
            throw new Error('Blacklist reads require a qualified WHERE predicate');
          }
          if (query.table === domain_blacklist_state) {
            if (options.stateHang) return new Promise<unknown[]>(() => {});
            if (options.stateError) throw options.stateError;
            return state ? [state] : [];
          }
          if (query.table === blacklisted_domains) {
            if (options.domainsHang) return new Promise<unknown[]>(() => {});
            if (options.domainsError) throw options.domainsError;
            const params = new PgDialect().sqlToQuery(query.condition as never).params;
            return (options.domains ?? [])
              .filter(domain => params.includes(domain))
              .slice(0, count)
              .map(domain => ({ domain }));
          }
          throw new Error('Unexpected blacklist table query');
        },
      };
      return chain;
    },
  };
  return { db, queries };
}

type FakeCacheOptions = {
  values?: Iterable<readonly [string, string]>;
  readError?: Error;
  writeError?: Error;
  deferError?: Error;
  readHang?: boolean;
  writeHang?: boolean;
};

function createCache(options: FakeCacheOptions = {}) {
  const values = new Map(options.values);
  const reads: string[] = [];
  const writes: { key: string; value: string; ttlSeconds: number }[] = [];
  const deferred: (() => Promise<void>)[] = [];
  const errors: unknown[] = [];
  const cache: DomainBlacklistCache = {
    get: vi.fn(async key => {
      reads.push(key);
      if (options.readHang) return new Promise<string | null>(() => {});
      if (options.readError) throw options.readError;
      return values.get(key) ?? null;
    }),
    set: vi.fn(async (key, value, ttlSeconds) => {
      writes.push({ key, value, ttlSeconds });
      if (options.writeHang) return new Promise<void>(() => {});
      if (options.writeError) throw options.writeError;
      values.set(key, value);
    }),
    defer: vi.fn(write => {
      if (options.deferError) throw options.deferError;
      deferred.push(write);
    }),
    onError: vi.fn(error => {
      errors.push(error);
    }),
  };
  return { cache, values, reads, writes, deferred, errors };
}

async function flushDeferred(cache: ReturnType<typeof createCache>): Promise<void> {
  for (const write of cache.deferred.splice(0)) await write();
}

function cacheKey(email: string, revision = 'revision-1'): string {
  const suffix = emailDomainSuffixes(email)?.[0];
  if (!suffix) throw new Error('Expected a cacheable domain suffix');
  return `domain-blacklist:${revision}:${email.includes('@') ? 'host' : 'suffix'}:${encodeURIComponent(suffix)}`;
}

describe('isEmailDomainBlacklisted', () => {
  it('queries readiness and only performs a bounded suffix lookup with qualified predicates', async () => {
    const captured = createDb({ domains: ['spam.com'] });
    const cache = createCache();

    await expect(
      isEmailDomainBlacklisted(captured.db as never, 'user@a.spam.com', [], cache.cache)
    ).resolves.toBe(true);

    expect(captured.queries.map(query => query.table)).toEqual([
      domain_blacklist_state,
      blacklisted_domains,
    ]);
    expect(captured.queries.every(query => query.limit === 1)).toBe(true);
    const dialect = new PgDialect();
    const statePredicate = dialect.sqlToQuery(captured.queries[0]?.condition as never);
    expect(statePredicate.sql).toBe('"domain_blacklist_state"."id" = $1');
    expect(statePredicate.params).toEqual([1]);
    const domainPredicate = dialect.sqlToQuery(captured.queries[1]?.condition as never);
    expect(domainPredicate.sql.toLowerCase()).toContain('"blacklisted_domains"."domain" in (');
    expect(domainPredicate.params).toEqual(['a.spam.com', 'spam.com', 'com']);
  });

  it.each([
    { email: 'user@SPAM.COM', domains: ['spam.com'], expected: true },
    { email: 'user@mail.a.spam.com', domains: ['spam.com'], expected: true },
    { email: 'user@notspam.com', domains: ['spam.com'], expected: false },
    { email: 'private@address@SPAM.COM', domains: ['spam.com'], expected: true },
    { email: 'spam.com', domains: ['spam.com'], expected: false },
    { email: 'mail.spam.com', domains: ['spam.com'], expected: true },
    { email: 'user@example.com', domains: ['com'], expected: true },
    { email: 'com', domains: ['com'], expected: false },
  ])(
    'preserves email domain matching semantics for $email',
    async ({ email, domains, expected }) => {
      const captured = createDb({ domains });

      await expect(
        isEmailDomainBlacklisted(captured.db as never, email, [], createCache().cache)
      ).resolves.toBe(expected);
    }
  );

  it.each([
    { cached: '1', expected: true },
    { cached: '0', expected: false },
  ])('uses a positive or negative Redis cache hit ($cached)', async ({ cached, expected }) => {
    const email = 'user@example.com';
    const key = cacheKey(email);
    const captured = createDb();
    const cache = createCache({ values: [[key, cached]] });

    await expect(
      isEmailDomainBlacklisted(captured.db as never, email, [], cache.cache)
    ).resolves.toBe(expected);

    expect(captured.queries).toHaveLength(1);
    expect(cache.reads).toEqual([key]);
    expect(cache.deferred).toHaveLength(0);
  });

  it.each([
    { domains: ['spam.com'], email: 'user@spam.com', expected: true, value: '1' },
    { domains: [], email: 'user@spam.com', expected: false, value: '0' },
  ])(
    'defers the $value cache write with a 60-second TTL',
    async ({ domains, email, expected, value }) => {
      const captured = createDb({ domains });
      const cache = createCache();
      const key = cacheKey(email);

      await expect(
        isEmailDomainBlacklisted(captured.db as never, email, [], cache.cache)
      ).resolves.toBe(expected);

      expect(cache.writes).toEqual([]);
      expect(cache.deferred).toHaveLength(1);
      await flushDeferred(cache);
      expect(cache.writes).toEqual([{ key, value, ttlSeconds: 60 }]);
    }
  );

  it('scopes cache values by revision so a late old fill cannot replace the new revision', async () => {
    const email = 'user@spam.com';
    const oldKey = cacheKey(email, 'old-revision');
    const newKey = cacheKey(email, 'new-revision');
    const cache = createCache({ values: [[newKey, '1']] });
    const oldDb = createDb({ state: { revision: 'old-revision', useEnvFallback: false } });
    const newDb = createDb({ state: { revision: 'new-revision', useEnvFallback: false } });

    await expect(isEmailDomainBlacklisted(oldDb.db as never, email, [], cache.cache)).resolves.toBe(
      false
    );
    await expect(isEmailDomainBlacklisted(newDb.db as never, email, [], cache.cache)).resolves.toBe(
      true
    );

    await flushDeferred(cache);
    expect(cache.values.get(oldKey)).toBe('0');
    expect(cache.values.get(newKey)).toBe('1');
    expect(cache.reads).toEqual([oldKey, newKey]);
  });

  it('falls back to the database when Redis reads fail', async () => {
    const readError = new Error('Redis read failed');
    const captured = createDb({ domains: ['spam.com'] });
    const cache = createCache({ readError });

    await expect(
      isEmailDomainBlacklisted(captured.db as never, 'user@spam.com', [], cache.cache)
    ).resolves.toBe(true);

    expect(captured.queries.map(query => query.table)).toEqual([
      domain_blacklist_state,
      blacklisted_domains,
    ]);
    expect(cache.errors).toEqual([readError]);
  });

  it('reports deferred Redis write failures without changing the database result', async () => {
    const writeError = new Error('Redis write failed');
    const captured = createDb({ domains: ['spam.com'] });
    const cache = createCache({ writeError });

    await expect(
      isEmailDomainBlacklisted(captured.db as never, 'user@spam.com', [], cache.cache)
    ).resolves.toBe(true);
    await flushDeferred(cache);

    expect(cache.errors).toEqual([writeError]);
    expect(cache.writes).toEqual([{ key: cacheKey('user@spam.com'), value: '1', ttlSeconds: 60 }]);
  });

  it('reports defer failures while returning the database result', async () => {
    const deferError = new Error('defer failed');
    const captured = createDb({ domains: ['spam.com'] });
    const cache = createCache({ deferError });

    await expect(
      isEmailDomainBlacklisted(captured.db as never, 'user@spam.com', [], cache.cache)
    ).resolves.toBe(true);

    expect(cache.errors).toEqual([deferError]);
    expect(cache.writes).toEqual([]);
  });

  it('uses environment fallback only after readiness is confirmed', async () => {
    const captured = createDb({ state: { revision: 'revision-1', useEnvFallback: true } });
    const cache = createCache();

    await expect(
      isEmailDomainBlacklisted(captured.db as never, 'user@SPAM.COM', ['spam.com'], cache.cache)
    ).resolves.toBe(true);
    expect(captured.queries.map(query => query.table)).toEqual([domain_blacklist_state]);
    expect(cache.reads).toEqual([]);
  });

  it('rejects an unready blacklist instead of using an empty fallback or cached value', async () => {
    const email = 'user@spam.com';
    const key = cacheKey(email);
    const captured = createDb({ state: null });
    const cache = createCache({ values: [[key, '1']] });

    await expect(
      isEmailDomainBlacklisted(captured.db as never, email, [], cache.cache)
    ).rejects.toThrow('Domain blacklist initialization has not completed');

    expect(captured.queries).toHaveLength(1);
    expect(cache.reads).toEqual([]);
  });

  it.each([
    { name: 'state query', options: { stateError: new Error('state DB failed') } },
    { name: 'domain query', options: { domainsError: new Error('domain DB failed') } },
  ])('propagates $name failures without failing open', async ({ options }) => {
    const captured = createDb(options);

    await expect(
      isEmailDomainBlacklisted(
        captured.db as never,
        'user@spam.com',
        ['spam.com'],
        createCache().cache
      )
    ).rejects.toThrow(options.stateError?.message ?? options.domainsError?.message);
  });

  it.each([
    { name: 'overlong domain', email: `user@${'a'.repeat(1025)}` },
    { name: 'too many labels', email: `user@${Array.from({ length: 129 }, () => 'a').join('.')}` },
  ])('blocks a $name before querying the database', async ({ email }) => {
    const captured = createDb();
    const cache = createCache();

    expect(emailDomainSuffixes(email)).toBeNull();
    await expect(
      isEmailDomainBlacklisted(captured.db as never, email, [], cache.cache)
    ).resolves.toBe(true);

    expect(captured.queries).toEqual([]);
    expect(cache.reads).toEqual([]);
  });

  it.each([{ stateHang: true }, { domainsHang: true }])(
    'fails closed within the database lookup deadline (%o)',
    async options => {
      vi.useFakeTimers();
      try {
        const captured = createDb(options);
        const cache = createCache();
        const result = expect(
          isEmailDomainBlacklisted(captured.db as never, 'user@spam.com', [], cache.cache)
        ).rejects.toThrow('database lookup timed out');
        await vi.advanceTimersByTimeAsync(1001);
        await result;
        expect(cache.deferred).toEqual([]);
      } finally {
        vi.useRealTimers();
      }
    }
  );

  it('bounds a stalled Redis read before using the selective database fallback', async () => {
    vi.useFakeTimers();
    try {
      const captured = createDb({ domains: ['spam.com'] });
      const cache = createCache({ readHang: true });
      const result = isEmailDomainBlacklisted(
        captured.db as never,
        'user@spam.com',
        [],
        cache.cache
      );
      await vi.advanceTimersByTimeAsync(201);
      await expect(result).resolves.toBe(true);
      expect(captured.queries).toHaveLength(2);
      expect(cache.errors).toEqual([
        expect.objectContaining({ message: 'Domain blacklist cache lookup timed out' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds a stalled deferred Redis write without changing admission', async () => {
    vi.useFakeTimers();
    try {
      const captured = createDb({ domains: ['spam.com'] });
      const cache = createCache({ writeHang: true });
      await expect(
        isEmailDomainBlacklisted(captured.db as never, 'user@spam.com', [], cache.cache)
      ).resolves.toBe(true);
      const writes = flushDeferred(cache);
      await vi.advanceTimersByTimeAsync(201);
      await writes;
      expect(cache.errors).toEqual([
        expect.objectContaining({ message: 'Domain blacklist cache write timed out' }),
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
