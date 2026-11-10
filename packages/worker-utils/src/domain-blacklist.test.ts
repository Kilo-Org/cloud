import { blacklisted_domains } from '@kilocode/db/schema';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DOMAIN_BLACKLIST_GENERATION_REDIS_KEY,
  emailDomainSuffixes,
  isEmailDomainBlacklisted,
  type DomainBlacklistCache,
} from './account-access';

const GENERATION = '11111111-1111-4111-8111-111111111111';
const NEXT_GENERATION = '22222222-2222-4222-8222-222222222222';

type CapturedQuery = {
  selection: unknown;
  table: unknown;
  condition: unknown;
  order: unknown;
  limit: number | null;
};

type FakeDbOptions = {
  domains?: readonly string[];
  domainsError?: Error;
  domainsHang?: boolean;
  domainsDelayMs?: number;
  probeError?: Error;
  probeHang?: boolean;
};

type QueryChain = {
  from: (table: unknown) => QueryChain;
  where: (condition: unknown) => QueryChain;
  orderBy: (order: unknown) => QueryChain;
  limit: (count: number) => Promise<unknown[]>;
};

function createDb(options: FakeDbOptions = {}) {
  const queries: CapturedQuery[] = [];
  const db = {
    select: (selection: unknown) => {
      const query: CapturedQuery = {
        selection,
        table: undefined,
        condition: undefined,
        order: undefined,
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
        orderBy(order) {
          query.order = order;
          return chain;
        },
        async limit(count) {
          query.limit = count;
          queries.push(query);
          if (query.table !== blacklisted_domains || count !== 1) {
            throw new Error('Expected a bounded blacklisted_domains query');
          }
          if (query.condition === undefined) {
            if (query.order === undefined) throw new Error('Existence probes require PK order');
            if (options.probeHang) return new Promise<unknown[]>(() => {});
            if (options.probeError) throw options.probeError;
            return [...(options.domains ?? [])]
              .sort()
              .slice(0, count)
              .map(domain => ({ domain }));
          }
          if (options.domainsHang) return new Promise<unknown[]>(() => {});
          if (options.domainsError) throw options.domainsError;
          if (options.domainsDelayMs) {
            await new Promise(resolve => setTimeout(resolve, options.domainsDelayMs));
          }
          const params = new PgDialect().sqlToQuery(query.condition as never).params;
          return (options.domains ?? [])
            .filter(domain => params.includes(domain))
            .slice(0, count)
            .map(domain => ({ domain }));
        },
      };
      return chain;
    },
  };
  return { db, queries };
}

type FakeCacheOptions = {
  generation?: string | null;
  values?: Iterable<readonly [string, string]>;
  readError?: Error;
  domainReadError?: Error;
  writeError?: Error;
  deferError?: Error;
  readHang?: boolean;
  domainReadHang?: boolean;
  writeHang?: boolean;
};

function createCache(options: FakeCacheOptions = {}) {
  const values = new Map(options.values);
  const generation = options.generation === undefined ? GENERATION : options.generation;
  if (generation !== null) values.set(DOMAIN_BLACKLIST_GENERATION_REDIS_KEY, generation);
  const reads: string[] = [];
  const writes: { key: string; value: string; ttlSeconds: number }[] = [];
  const deferred: (() => Promise<void>)[] = [];
  const errors: unknown[] = [];
  const cache: DomainBlacklistCache = {
    get: vi.fn(async key => {
      reads.push(key);
      if (options.readHang) return new Promise<string | null>(() => {});
      if (options.readError) throw options.readError;
      if (key !== DOMAIN_BLACKLIST_GENERATION_REDIS_KEY) {
        if (options.domainReadHang) return new Promise<string | null>(() => {});
        if (options.domainReadError) throw options.domainReadError;
      }
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

function cacheKey(email: string, generation = GENERATION): string {
  const suffix = emailDomainSuffixes(email)?.[0];
  if (!suffix) throw new Error('Expected a cacheable domain suffix');
  return `domain-blacklist:${generation}:${email.includes('@') ? 'host' : 'suffix'}:${encodeURIComponent(suffix)}`;
}

describe('isEmailDomainBlacklisted', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-10T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('performs only a bounded normalized suffix lookup on the domain PK', async () => {
    const captured = createDb({ domains: ['spam.com'] });
    const cache = createCache();

    await expect(
      isEmailDomainBlacklisted(captured.db as never, 'user@A.SPAM.COM', [], cache.cache)
    ).resolves.toBe(true);

    expect(captured.queries).toHaveLength(1);
    expect(captured.queries[0]).toMatchObject({
      selection: { domain: blacklisted_domains.domain },
      table: blacklisted_domains,
      limit: 1,
      order: undefined,
    });
    const predicate = new PgDialect().sqlToQuery(captured.queries[0]?.condition as never);
    expect(predicate.sql.toLowerCase()).toContain('"blacklisted_domains"."domain" in (');
    expect(predicate.params).toEqual(['a.spam.com', 'spam.com', 'com']);
    expect(cache.reads).toEqual([
      DOMAIN_BLACKLIST_GENERATION_REDIS_KEY,
      cacheKey('user@a.spam.com'),
    ]);
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
      await expect(
        isEmailDomainBlacklisted(createDb({ domains }).db as never, email, [], createCache().cache)
      ).resolves.toBe(expected);
    }
  );

  it('keeps host and no-at suffix cache namespaces distinct', async () => {
    const captured = createDb({ domains: ['spam.com'] });
    const cache = createCache();
    await expect(
      isEmailDomainBlacklisted(captured.db as never, 'user@spam.com', [], cache.cache)
    ).resolves.toBe(true);
    await flushDeferred(cache);
    await expect(
      isEmailDomainBlacklisted(captured.db as never, 'mail.spam.com', [], cache.cache)
    ).resolves.toBe(true);
    expect(cache.reads).toContain(`domain-blacklist:${GENERATION}:host:spam.com`);
    expect(cache.reads).toContain(`domain-blacklist:${GENERATION}:suffix:spam.com`);
    expect(captured.queries).toHaveLength(2);
  });

  it.each([
    { cached: '1', expected: true },
    { cached: '0', expected: false },
  ])('uses a $cached cache hit without any PG query', async ({ cached, expected }) => {
    const email = 'user@example.com';
    const captured = createDb();
    const cache = createCache({ values: [[cacheKey(email), cached]] });
    await expect(
      isEmailDomainBlacklisted(captured.db as never, email, [], cache.cache)
    ).resolves.toBe(expected);
    expect(captured.queries).toEqual([]);
    expect(cache.reads).toEqual([DOMAIN_BLACKLIST_GENERATION_REDIS_KEY, cacheKey(email)]);
    expect(cache.deferred).toEqual([]);
  });

  it.each([true, false])('caches the source PG result %s for at most 60 seconds', async blocked => {
    const email = 'user@spam.com';
    const captured = createDb({ domains: blocked ? ['spam.com'] : [] });
    const cache = createCache();
    await expect(
      isEmailDomainBlacklisted(captured.db as never, email, [], cache.cache)
    ).resolves.toBe(blocked);
    expect(cache.writes).toEqual([]);
    await flushDeferred(cache);
    expect(cache.writes).toEqual([
      { key: cacheKey(email), value: blocked ? '1' : '0', ttlSeconds: 60 },
    ]);
    await expect(
      isEmailDomainBlacklisted(captured.db as never, email, [], cache.cache)
    ).resolves.toBe(blocked);
    expect(captured.queries).toHaveLength(1);
  });

  it('uses a stable initial namespace when the generation key is missing', async () => {
    const email = 'user@spam.com';
    const captured = createDb();
    const cache = createCache({ generation: null });
    await isEmailDomainBlacklisted(captured.db as never, email, [], cache.cache);
    await flushDeferred(cache);
    await isEmailDomainBlacklisted(captured.db as never, email, [], cache.cache);
    expect(captured.queries).toHaveLength(1);
    expect(cache.writes).toEqual([{ key: cacheKey(email, 'initial'), value: '0', ttlSeconds: 60 }]);
    expect(cache.reads).toEqual([
      DOMAIN_BLACKLIST_GENERATION_REDIS_KEY,
      cacheKey(email, 'initial'),
      DOMAIN_BLACKLIST_GENERATION_REDIS_KEY,
      cacheKey(email, 'initial'),
    ]);
  });

  it.each(['', 'initial', 'not-a-uuid', ' '.repeat(36)])(
    'bypasses all domain caching for malformed generation %j',
    async generation => {
      const captured = createDb({ domains: ['spam.com'] });
      const cache = createCache({ generation });
      await expect(
        isEmailDomainBlacklisted(captured.db as never, 'user@spam.com', [], cache.cache)
      ).resolves.toBe(true);
      expect(cache.reads).toEqual([DOMAIN_BLACKLIST_GENERATION_REDIS_KEY]);
      expect(cache.errors).toHaveLength(1);
      expect(cache.deferred).toEqual([]);
      expect(captured.queries).toHaveLength(1);
    }
  );

  it.each([true, false])(
    'bypasses cached allowance and denial on a generation read error (PG blocked %s)',
    async blocked => {
      const readError = new Error('Redis read failed');
      const email = 'user@spam.com';
      const captured = createDb({ domains: blocked ? ['spam.com'] : [] });
      const cache = createCache({
        readError,
        values: [[cacheKey(email), blocked ? '0' : '1']],
      });
      await expect(
        isEmailDomainBlacklisted(captured.db as never, email, [], cache.cache)
      ).resolves.toBe(blocked);
      expect(cache.reads).toEqual([DOMAIN_BLACKLIST_GENERATION_REDIS_KEY]);
      expect(cache.errors).toEqual([readError]);
      expect(cache.deferred).toEqual([]);
      expect(captured.queries).toHaveLength(1);
    }
  );

  it.each([true, false])(
    'rotates both cache polarities and isolates late old-generation fills (old blocked %s)',
    async blocked => {
      const email = 'user@spam.com';
      const cache = createCache();
      const oldDb = createDb({ domains: blocked ? ['spam.com'] : [] });
      await expect(
        isEmailDomainBlacklisted(oldDb.db as never, email, [], cache.cache)
      ).resolves.toBe(blocked);
      cache.values.set(DOMAIN_BLACKLIST_GENERATION_REDIS_KEY, NEXT_GENERATION);
      const newDb = createDb({ domains: blocked ? [] : ['spam.com'] });
      await expect(
        isEmailDomainBlacklisted(newDb.db as never, email, [], cache.cache)
      ).resolves.toBe(!blocked);
      const [oldFill, newFill] = cache.deferred.splice(0);
      await newFill?.();
      await oldFill?.();
      expect(cache.values.get(cacheKey(email))).toBe(blocked ? '1' : '0');
      expect(cache.values.get(cacheKey(email, NEXT_GENERATION))).toBe(blocked ? '0' : '1');
      await expect(
        isEmailDomainBlacklisted(newDb.db as never, email, [], cache.cache)
      ).resolves.toBe(!blocked);
      expect(newDb.queries).toHaveLength(1);
    }
  );

  it.each([true, false])(
    'anchors delayed deferred TTL to PG observation time when generation remains unchanged (%s)',
    async blocked => {
      const captured = createDb({ domains: blocked ? ['spam.com'] : [], domainsDelayMs: 500 });
      const cache = createCache();
      const result = isEmailDomainBlacklisted(
        captured.db as never,
        'user@spam.com',
        [],
        cache.cache
      );
      await vi.advanceTimersByTimeAsync(500);
      await expect(result).resolves.toBe(blocked);
      await vi.advanceTimersByTimeAsync(20_100);
      await flushDeferred(cache);
      expect(cache.writes).toEqual([
        { key: cacheKey('user@spam.com'), value: blocked ? '1' : '0', ttlSeconds: 39 },
      ]);
    }
  );

  it.each([59_001, 60_000, 90_000])('skips expired deferred fills after %sms', async delay => {
    const cache = createCache();
    await isEmailDomainBlacklisted(createDb().db as never, 'user@spam.com', [], cache.cache);
    await vi.advanceTimersByTimeAsync(delay);
    await flushDeferred(cache);
    expect(cache.writes).toEqual([]);
    expect(cache.errors).toEqual([]);
  });

  it('never exceeds the cache TTL budget when the local clock moves backwards', async () => {
    const cache = createCache();
    await isEmailDomainBlacklisted(createDb().db as never, 'user@spam.com', [], cache.cache);
    vi.setSystemTime(Date.now() - 10_000);
    await flushDeferred(cache);
    expect(cache.writes).toEqual([{ key: cacheKey('user@spam.com'), value: '0', ttlSeconds: 60 }]);
  });

  it.each(['invalid', null])('queries PG on a per-domain cache miss %j', async value => {
    const email = 'user@spam.com';
    const cache = createCache({ values: value === null ? [] : [[cacheKey(email), value]] });
    const captured = createDb({ domains: ['spam.com'] });
    await expect(
      isEmailDomainBlacklisted(captured.db as never, email, [], cache.cache)
    ).resolves.toBe(true);
    expect(captured.queries).toHaveLength(1);
  });

  it('falls back to PG and can fill the known namespace when a domain-cache read fails', async () => {
    const domainReadError = new Error('Domain cache read failed');
    const captured = createDb({ domains: ['spam.com'] });
    const cache = createCache({ domainReadError });
    await expect(
      isEmailDomainBlacklisted(captured.db as never, 'user@spam.com', [], cache.cache)
    ).resolves.toBe(true);
    await flushDeferred(cache);
    expect(cache.errors).toEqual([domainReadError]);
    expect(cache.writes).toHaveLength(1);
  });

  it.each(['write', 'defer'] as const)(
    'reports %s failures without changing PG admission',
    async kind => {
      const error = new Error(`${kind} failed`);
      const cache = createCache(kind === 'write' ? { writeError: error } : { deferError: error });
      await expect(
        isEmailDomainBlacklisted(
          createDb({ domains: ['spam.com'] }).db as never,
          'user@spam.com',
          [],
          cache.cache
        )
      ).resolves.toBe(true);
      await flushDeferred(cache);
      expect(cache.errors).toEqual([error]);
    }
  );

  it.each([
    { domains: [], expected: true },
    { domains: ['unrelated.com'], expected: false },
  ])(
    'enables environment fallback only when the whole PG table is empty (%o)',
    async ({ domains, expected }) => {
      const captured = createDb({ domains });
      const cache = createCache();
      await expect(
        isEmailDomainBlacklisted(captured.db as never, 'user@SPAM.COM', ['spam.com'], cache.cache)
      ).resolves.toBe(expected);
      expect(captured.queries).toHaveLength(2);
      const probe = captured.queries[1];
      expect(probe).toMatchObject({
        selection: { domain: blacklisted_domains.domain },
        table: blacklisted_domains,
        condition: undefined,
        limit: 1,
      });
      expect(new PgDialect().sqlToQuery(probe?.order as never).sql).toBe(
        '"blacklisted_domains"."domain" asc'
      );
      await flushDeferred(cache);
      expect(cache.writes[0]?.value).toBe('0');
    }
  );

  it.each([{ domains: [] }, { domains: ['unrelated.com'] }])(
    'probes table emptiness on an environment-matching negative hit (%j)',
    async ({ domains }) => {
      const email = 'user@spam.com';
      const captured = createDb({ domains });
      const cache = createCache({ values: [[cacheKey(email), '0']] });
      await expect(
        isEmailDomainBlacklisted(captured.db as never, email, ['spam.com'], cache.cache)
      ).resolves.toBe(domains.length === 0);
      expect(captured.queries).toHaveLength(1);
      expect(captured.queries[0]?.condition).toBeUndefined();
      expect(cache.deferred).toEqual([]);
    }
  );

  it('does not probe emptiness when the environment fallback does not match', async () => {
    const captured = createDb();
    await expect(
      isEmailDomainBlacklisted(
        captured.db as never,
        'user@allowed.com',
        ['spam.com'],
        createCache().cache
      )
    ).resolves.toBe(false);
    expect(captured.queries).toHaveLength(1);
    expect(captured.queries[0]?.condition).toBeDefined();
  });

  it.each([false, true])(
    'keeps web fallback and Worker [] independent in a shared cache (Worker first %s)',
    async workerFirst => {
      const email = 'user@spam.com';
      const cache = createCache();
      const captured = createDb();
      const fallbacks = workerFirst ? [[], ['spam.com']] : [['spam.com'], []];
      for (const fallback of fallbacks) {
        await expect(
          isEmailDomainBlacklisted(captured.db as never, email, fallback, cache.cache)
        ).resolves.toBe(fallback.length > 0);
        await flushDeferred(cache);
      }
      expect(cache.writes).toEqual([{ key: cacheKey(email), value: '0', ttlSeconds: 60 }]);
      expect(captured.queries.filter(query => query.condition !== undefined)).toHaveLength(1);
      expect(captured.queries.filter(query => query.condition === undefined)).toHaveLength(1);
    }
  );

  it('does not probe the table for a positive PG hit even if environment fallback matches', async () => {
    const captured = createDb();
    const cache = createCache({ values: [[cacheKey('user@spam.com'), '1']] });
    await expect(
      isEmailDomainBlacklisted(captured.db as never, 'user@spam.com', ['spam.com'], cache.cache)
    ).resolves.toBe(true);
    expect(captured.queries).toEqual([]);
  });

  it.each([
    { domainsError: new Error('domain DB failed') },
    { probeError: new Error('probe DB failed') },
  ])('propagates PG lookup and existence-probe failures (%o)', async options => {
    const cache = createCache();
    await expect(
      isEmailDomainBlacklisted(
        createDb(options).db as never,
        'user@spam.com',
        ['spam.com'],
        cache.cache
      )
    ).rejects.toThrow(options.domainsError?.message ?? options.probeError?.message);
  });

  it.each([
    { name: 'overlong domain', email: `user@${'a'.repeat(1025)}` },
    { name: 'too many labels', email: `user@${Array.from({ length: 129 }, () => 'a').join('.')}` },
  ])('blocks a $name before any cache or database lookup', async ({ email }) => {
    const captured = createDb();
    const cache = createCache();
    expect(emailDomainSuffixes(email)).toBeNull();
    await expect(
      isEmailDomainBlacklisted(captured.db as never, email, [], cache.cache)
    ).resolves.toBe(true);
    expect(captured.queries).toEqual([]);
    expect(cache.reads).toEqual([]);
  });

  it.each([{ domainsHang: true }, { probeHang: true }])(
    'bounds PG query and probe timeouts (%o)',
    async options => {
      const result = expect(
        isEmailDomainBlacklisted(
          createDb(options).db as never,
          'user@spam.com',
          ['spam.com'],
          createCache().cache
        )
      ).rejects.toThrow('database lookup timed out');
      await vi.advanceTimersByTimeAsync(1001);
      await result;
    }
  );

  it.each([
    {
      options: { readHang: true },
      message: 'Domain blacklist generation lookup timed out',
      fills: 0,
    },
    {
      options: { domainReadHang: true },
      message: 'Domain blacklist cache lookup timed out',
      fills: 1,
    },
  ])('bounds stalled cache reads before PG fallback (%o)', async ({ options, message, fills }) => {
    const captured = createDb({ domains: ['spam.com'] });
    const cache = createCache(options);
    const result = isEmailDomainBlacklisted(captured.db as never, 'user@spam.com', [], cache.cache);
    await vi.advanceTimersByTimeAsync(201);
    await expect(result).resolves.toBe(true);
    expect(captured.queries).toHaveLength(1);
    expect(cache.errors).toEqual([expect.objectContaining({ message })]);
    expect(cache.deferred).toHaveLength(fills);
  });

  it('bounds stalled deferred cache writes without changing admission', async () => {
    const cache = createCache({ writeHang: true });
    await expect(
      isEmailDomainBlacklisted(
        createDb({ domains: ['spam.com'] }).db as never,
        'user@spam.com',
        [],
        cache.cache
      )
    ).resolves.toBe(true);
    const writes = flushDeferred(cache);
    await vi.advanceTimersByTimeAsync(201);
    await writes;
    expect(cache.errors).toEqual([
      expect.objectContaining({ message: 'Domain blacklist cache write timed out' }),
    ]);
  });
});
