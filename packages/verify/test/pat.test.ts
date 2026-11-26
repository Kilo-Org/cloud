import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PAT_LENGTH,
  PAT_LOOKUPS_PER_SECOND_PER_ADDRESS,
  PAT_LOOKUP_TIMEOUT_MS,
  PAT_MAX_STALE_MS,
  PAT_NEGATIVE_TTL_MS,
  PAT_POSITIVE_TTL_MS,
  PAT_PREFIX,
  createPatString,
  createVerifier,
  hashPat,
  parsePat,
  patReference,
  type PatCacheKey,
  type PatCacheKeys,
  type PatConfig,
  type PatLookupResult,
  type PatRecord,
  type Route,
  type SharedPatCache,
  type VerifyResult,
} from '../src/index';
import { newCallScope } from '../src/flight';
import {
  MAX_INSTANCE_ENTRIES,
  MAX_TRACKED_ADDRESSES,
  createPatResolver,
  type PatRequest,
} from '../src/pat';
import {
  AUDIENCE,
  NO_PAT_SCOPE,
  OTHER_SCOPE,
  RESOURCE_METADATA,
  SCOPE,
  SESSION_SCOPE,
  UTS_ISSUER,
  UTS_REGISTRY,
  bearer,
  drain,
  emptyList,
  fakeAllTimers,
  gate,
  harness,
  nowSeconds,
  type Gate,
  type Harness,
} from './helpers';

// Design 5.3, 5.6 and 7 PAT rules: format, two cache layers, feed override, fail-closed lookups.

describe('PAT format', () => {
  it('creates PATs that pass the offline check', () => {
    for (let i = 0; i < 50; i++) {
      const pat = createPatString();
      expect(pat).toHaveLength(PAT_LENGTH);
      expect(pat.startsWith(PAT_PREFIX)).toBe(true);
      expect(parsePat(pat)).toEqual({ ok: true, pat });
    }
  });

  it('creates a different PAT each time', () => {
    expect(new Set(Array.from({ length: 20 }, createPatString)).size).toBe(20);
  });

  const valid = createPatString();
  const flip = (value: string, index: number) =>
    value.slice(0, index) + (value[index] === 'A' ? 'B' : 'A') + value.slice(index + 1);

  it.each([
    ['another prefix', valid.replace('kilo_pat_', 'kilo_rt__')],
    ['a changed body character', flip(valid, PAT_PREFIX.length + 3)],
    ['a changed checksum character', flip(valid, PAT_LENGTH - 1)],
    ['one character short', valid.slice(0, -1)],
    ['one character long', `${valid}A`],
    [
      'a character outside base64url',
      `${valid.slice(0, PAT_PREFIX.length)}+${valid.slice(PAT_PREFIX.length + 1)}`,
    ],
    ['the prefix alone', PAT_PREFIX],
  ])('refuses %s', (_name, value) => {
    expect(parsePat(value)).toEqual({ ok: false });
  });

  it('hashes the whole PAT with SHA-256 as lowercase hex', async () => {
    expect(await hashPat('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('names a PAT in logs by the first 8 characters of its base64url SHA-256', async () => {
    expect(await patReference('abc')).toBe('ungWv48B');
  });
});

type FakeLookup = {
  records: Map<string, PatRecord>;
  answer: PatLookupResult['status'] | 'throw' | 'hang';
  gate: Gate | null;
  hashes: string[];
  lookup: PatConfig['lookup'];
};

function fakeLookup(): FakeLookup {
  const fake: FakeLookup = {
    records: new Map(),
    answer: 'found',
    gate: null,
    hashes: [],
    lookup: async hash => {
      fake.hashes.push(hash);
      if (fake.gate !== null) await fake.gate.promise;
      switch (fake.answer) {
        case 'throw':
          throw new Error('UTS unreachable');
        case 'hang':
          return await Promise.withResolvers<PatLookupResult>().promise;
        case 'rate_limited':
          return { status: 'rate_limited', retryAfterSeconds: 3 };
        case 'unavailable':
          return { status: 'unavailable', retryAfterSeconds: 4 };
        case 'not_found':
          return { status: 'not_found' };
        case 'found': {
          const record = fake.records.get(hash);
          return record === undefined ? { status: 'not_found' } : { status: 'found', record };
        }
      }
    },
  };
  return fake;
}

type FakeShared = SharedPatCache & { entries: Map<string, string>; puts: number };

function fakeShared(): FakeShared {
  const fake: FakeShared = {
    entries: new Map(),
    puts: 0,
    async get(key) {
      return fake.entries.get(key) ?? null;
    },
    async put(key, value) {
      fake.puts++;
      fake.entries.set(key, value);
    },
  };
  return fake;
}

const KEY_V1: PatCacheKey = { version: 'v1', secret: 'workload-key-one' };
const KEY_V2: PatCacheKey = { version: 'v2', secret: 'workload-key-two' };
const KEY_V3: PatCacheKey = { version: 'v3', secret: 'workload-key-three' };

function record(overrides: Partial<PatRecord> = {}): PatRecord {
  return {
    patId: 'pat-1',
    subject: 'user-1',
    audience: AUDIENCE,
    scope: SCOPE,
    org: null,
    expiresAt: nowSeconds() + 90 * 24 * 3600,
    ...overrides,
  };
}

/** A shared-cache value as the library writes it, signed with `key`, for entries it would not write. */
async function signedEnvelope(hash: string, entry: unknown, key: PatCacheKey): Promise<string> {
  const text = JSON.stringify(entry);
  const hmac = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(key.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign(
      'HMAC',
      hmac,
      new TextEncoder().encode(`pat:session-ingest:${hash}\n${text}`)
    )
  );
  return JSON.stringify({ v: 1, k: key.version, e: text, m: btoa(String.fromCharCode(...mac)) });
}

let lookup: FakeLookup;
let shared: FakeShared;
let h: Harness;
let pat: string;

async function instance(
  options: {
    workload?: string;
    current?: PatCacheKey;
    previous?: PatCacheKey;
    cacheKeys?: PatConfig['cacheKeys'];
  } = {}
): Promise<Harness> {
  return await harness({
    pat: {
      lookup: lookup.lookup,
      workload: options.workload ?? 'session-ingest',
      sharedCache: shared,
      cacheKeys:
        options.cacheKeys ??
        (async () => ({ current: options.current ?? KEY_V1, previous: options.previous })),
    },
  });
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-25T12:00:00Z'));
  lookup = fakeLookup();
  shared = fakeShared();
  h = await instance();
  pat = createPatString();
  lookup.records.set(await hashPat(pat), record());
});

afterEach(() => {
  vi.useRealTimers();
});

function advance(ms: number): void {
  vi.setSystemTime(Date.now() + ms);
}

async function verify(
  value = pat,
  route: Partial<Route> = {},
  on: Harness = h,
  clientAddress: string | null = '203.0.113.7'
): Promise<VerifyResult> {
  return await on.verifier.verify(
    bearer(value),
    { issuer: 'uts', scope: SCOPE, ...route },
    { ...on.ctx, clientAddress }
  );
}

describe('offline check', () => {
  it('refuses a malformed PAT with 401 and no lookup, cache write or feed fetch', async () => {
    expect(await verify(`${pat.slice(0, -1)}x`)).toMatchObject({
      ok: false,
      status: 401,
      error: 'invalid_token',
      reason: 'pat_malformed',
    });
    expect(lookup.hashes).toEqual([]);
    expect(shared.puts).toBe(0);
    expect(h.feed.calls).toBe(0);
  });

  it('accepts a known PAT and names the caller', async () => {
    expect(await verify()).toMatchObject({
      ok: true,
      credential: 'pat',
      issuerKind: 'uts',
      caller: { kind: 'pat', subject: 'user-1', patId: 'pat-1', org: null },
    });
    expect(lookup.hashes).toEqual([await hashPat(pat)]);
  });
});

describe('two cache layers keyed by the full hash', () => {
  it.each([
    ['a positive answer serves from the instance for 60 s', 'found', PAT_POSITIVE_TTL_MS - 1, 1],
    [
      'a negative answer serves from the instance for 30 s',
      'not_found',
      PAT_NEGATIVE_TTL_MS - 1,
      1,
    ],
    ['a negative answer is looked up again after 30 s', 'not_found', PAT_NEGATIVE_TTL_MS, 2],
  ] as const)('%s', async (_name, answer, after, lookups) => {
    lookup.answer = answer;
    await verify();
    advance(after);
    await verify();
    expect(lookup.hashes).toHaveLength(lookups);
  });

  it('writes 60 s positive and 30 s negative entries to the shared cache', async () => {
    const ttls: number[] = [];
    const put = shared.put;
    shared.put = async (key, value, ttl) => {
      ttls.push(ttl);
      await put(key, value, ttl);
    };
    await verify();
    lookup.answer = 'not_found';
    await verify(createPatString());
    await drain(h.background);
    expect(ttls).toEqual([60, 30]);
  });

  it('serves another instance of the same workload from the shared cache', async () => {
    await verify();
    await drain(h.background);
    const other = await instance();
    expect(await verify(pat, {}, other)).toMatchObject({ ok: true });
    expect(lookup.hashes).toHaveLength(1);
  });

  it('serves a shared negative entry for 30 s', async () => {
    lookup.answer = 'not_found';
    await verify();
    await drain(h.background);
    const other = await instance();
    expect(await verify(pat, {}, other)).toMatchObject({ ok: false, reason: 'pat_not_found' });
    expect(lookup.hashes).toHaveLength(1);
  });

  it.each([
    ['another workload', { workload: 'gateway' }, 2],
    ['the previous key after a rotation', { current: KEY_V2, previous: KEY_V1 }, 1],
    ['a key two rotations later', { current: KEY_V3, previous: KEY_V2 }, 2],
    [
      'a key with the same version and another secret',
      { current: { version: 'v1', secret: 'x' } },
      2,
    ],
  ])('reading the entry with %s', async (_name, options, lookups) => {
    await verify();
    await drain(h.background);
    const other = await instance(options);
    expect(await verify(pat, {}, other)).toMatchObject({ ok: true });
    expect(lookup.hashes).toHaveLength(lookups);
  });

  it('drops a shared entry whose text was changed', async () => {
    await verify();
    await drain(h.background);
    for (const [key, value] of shared.entries) {
      shared.entries.set(key, value.replace('user-1', 'user-2'));
    }
    const other = await instance();
    expect(await verify(pat, {}, other)).toMatchObject({ ok: true, caller: { subject: 'user-1' } });
    expect(lookup.hashes).toHaveLength(2);
  });

  it('keys shared entries by workload and hash, never by the PAT', async () => {
    await verify();
    await drain(h.background);
    expect([...shared.entries.keys()]).toEqual([`pat:session-ingest:${await hashPat(pat)}`]);
    expect(JSON.stringify([...shared.entries])).not.toContain(pat);
  });

  it.each([
    ['a positive entry claiming more than 60 s', 'found', PAT_POSITIVE_TTL_MS + 1_000],
    ['a negative entry claiming more than 30 s', 'not_found', PAT_NEGATIVE_TTL_MS + 1_000],
    ['an entry already expired', 'found', -1],
  ] as const)('drops %s, though its HMAC is valid', async (_name, kind, lifetimeMs) => {
    const hash = await hashPat(pat);
    const entry =
      kind === 'found'
        ? { kind, record: record(), expiresAt: Date.now() + lifetimeMs }
        : { kind, expiresAt: Date.now() + lifetimeMs };
    shared.entries.set(`pat:session-ingest:${hash}`, await signedEnvelope(hash, entry, KEY_V1));
    expect(await verify()).toMatchObject({ ok: true });
    expect(lookup.hashes).toEqual([hash]);
  });

  it('serves a valid shared entry it did not write itself', async () => {
    const hash = await hashPat(pat);
    const entry = {
      kind: 'found',
      record: record({ patId: 'pat-shared' }),
      expiresAt: Date.now() + 1_000,
    };
    shared.entries.set(`pat:session-ingest:${hash}`, await signedEnvelope(hash, entry, KEY_V1));
    expect(await verify()).toMatchObject({ ok: true, caller: { patId: 'pat-shared' } });
    expect(lookup.hashes).toEqual([]);
  });
});

describe('the feed entry for a PAT id overrides both layers', () => {
  it('refuses a cached PAT once the feed lists its id', async () => {
    await verify();
    await drain(h.background);
    h.feed.list = { ...emptyList(), revokedPatIds: new Set(['pat-1']) };
    advance(10_000);
    await verify();
    await drain(h.background);
    expect(await verify()).toMatchObject({ ok: false, status: 401, reason: 'pat_revoked' });
    // A second instance reading the still-cached shared entry refuses it as well.
    const other = await instance();
    other.feed.list = h.feed.list;
    expect(await verify(pat, {}, other)).toMatchObject({ ok: false, reason: 'pat_revoked' });
  });

  it('refuses a PAT, cached or not, once the signed head is over 60 s old', async () => {
    await verify();
    h.feed.mode = 'fail';
    advance(60_001);
    expect(await verify()).toMatchObject({ ok: false, status: 503, reason: 'feed_unavailable' });
  });

  it('serves no stale entry once the signed head is over 60 s old', async () => {
    await verify();
    lookup.answer = 'throw';
    h.feed.mode = 'fail';
    advance(PAT_POSITIVE_TTL_MS + 1);
    expect(await verify()).toMatchObject({ ok: false, status: 503, reason: 'feed_unavailable' });
    expect(lookup.hashes).toHaveLength(1);
  });
});

describe('fail-closed lookups', () => {
  // `retry` is the Retry-After: the later of the 2 s retry floor and the answer's own hint.
  it.each([
    ['a lookup that throws answers 503', 'throw', 2],
    ['a UTS 503 answers 503', 'unavailable', 4],
    ['a UTS 429 answers 503: UTS is overloaded, not this client', 'rate_limited', 3],
  ] as const)('%s', async (_name, answer, retry) => {
    lookup.answer = answer;
    const result = await verify();
    expect(result).toMatchObject({
      ok: false,
      status: 503,
      error: 'temporarily_unavailable',
      reason: 'pat_lookup_unavailable',
      headers: { 'retry-after': String(retry) },
    });
    // Inside the retry time the hash is not looked up again.
    expect(await verify()).toMatchObject({ ok: false, status: 503 });
    expect(lookup.hashes).toHaveLength(1);
  });

  it('answers 503 once a hung lookup passes its timeout', async () => {
    lookup.answer = 'hang';
    const pending = verify();
    await vi.waitFor(() => expect(lookup.hashes).toHaveLength(1));
    advance(5_000);
    expect(await pending).toMatchObject({
      ok: false,
      status: 503,
      reason: 'pat_lookup_unavailable',
    });
  });

  it.each(['throw', 'unavailable', 'rate_limited'] as const)(
    'a %s answer never evicts a valid cached entry',
    async answer => {
      await verify();
      lookup.answer = answer;
      advance(PAT_POSITIVE_TTL_MS - 1);
      expect(await verify()).toMatchObject({ ok: true });
      // Past the positive lifetime the refresh fails, and the entry still serves stale.
      advance(1);
      expect(await verify()).toMatchObject({ ok: true });
      await drain(h.background);
      expect(await verify()).toMatchObject({ ok: true });
    }
  );

  it('serves an expired entry stale for up to 10 minutes while one refresh runs', async () => {
    await verify();
    lookup.answer = 'throw';
    advance(PAT_POSITIVE_TTL_MS);
    lookup.gate = gate();
    const results = await Promise.all(Array.from({ length: 5 }, () => verify()));
    expect(results.every(result => result.ok)).toBe(true);
    expect(lookup.hashes).toHaveLength(2);
    expect(h.background.length).toBeGreaterThanOrEqual(1);
    lookup.gate.release();
    await drain(h.background);
    lookup.gate = null;

    advance(PAT_MAX_STALE_MS - 1);
    expect(await verify()).toMatchObject({ ok: true });
    await drain(h.background);
    advance(1);
    expect(await verify()).toMatchObject({
      ok: false,
      status: 503,
      reason: 'pat_lookup_unavailable',
    });
  });

  it('replaces a stale entry when the background refresh succeeds', async () => {
    await verify();
    advance(PAT_POSITIVE_TTL_MS);
    expect(await verify()).toMatchObject({ ok: true });
    await drain(h.background);
    expect(lookup.hashes).toHaveLength(2);
    advance(PAT_POSITIVE_TTL_MS - 1);
    await verify();
    expect(lookup.hashes).toHaveLength(2);
  });
});

describe('merging and the per-address limit', () => {
  it('merges concurrent lookups for one hash into one call', async () => {
    lookup.gate = gate();
    const pending = Array.from({ length: 10 }, () => verify());
    await vi.waitFor(() => expect(lookup.hashes).toHaveLength(1));
    lookup.gate.release();
    const results = await Promise.all(pending);
    expect(results.every(result => result.ok)).toBe(true);
    expect(lookup.hashes).toHaveLength(1);
  });

  it('merges lookups that each waited on a slow shared-cache read', async () => {
    const held = gate();
    let reads = 0;
    const get = shared.get;
    shared.get = async key => {
      reads++;
      await held.promise;
      return await get(key);
    };
    const pending = Array.from({ length: 5 }, () => verify());
    await vi.waitFor(() => expect(reads).toBe(5));
    held.release();
    const results = await Promise.all(pending);
    expect(results.every(result => result.ok)).toBe(true);
    expect(lookup.hashes).toHaveLength(1);
  });

  it(`answers 429 above ${PAT_LOOKUPS_PER_SECOND_PER_ADDRESS} uncached lookups per second per address, before the lookup`, async () => {
    lookup.answer = 'not_found';
    const pats = Array.from({ length: PAT_LOOKUPS_PER_SECOND_PER_ADDRESS + 1 }, createPatString);
    const results = [];
    for (const value of pats) results.push(await verify(value));
    expect(results.slice(0, -1).every(result => !result.ok && result.status === 401)).toBe(true);
    expect(results.at(-1)).toMatchObject({ ok: false, status: 429, error: 'too_many_requests' });
    expect(lookup.hashes).toHaveLength(PAT_LOOKUPS_PER_SECOND_PER_ADDRESS);

    // Another address has its own budget; the same address gets a new one a second later.
    expect(await verify(createPatString(), {}, h, '198.51.100.9')).toMatchObject({ status: 401 });
    advance(1_000);
    expect(await verify(createPatString())).toMatchObject({ status: 401 });
  });

  it('serves cached PATs to an address that is over its lookup limit', async () => {
    await verify();
    lookup.answer = 'not_found';
    for (let i = 0; i < PAT_LOOKUPS_PER_SECOND_PER_ADDRESS; i++) await verify(createPatString());
    expect(await verify(createPatString())).toMatchObject({ status: 429 });
    expect(await verify()).toMatchObject({ ok: true });
  });
});

describe('PAT record checks', () => {
  // Rows are built inside the test, after the fake clock is set.
  it.each<[string, () => PatRecord, Partial<Route>, Record<string, unknown>]>([
    [
      'an expired PAT is refused',
      () => record({ expiresAt: nowSeconds() - 1 }),
      {},
      { status: 401, reason: 'pat_expired' },
    ],
    [
      'a PAT of another audience is refused',
      () => record({ audience: 'gateway', scope: 'gateway:models.read' }),
      {},
      { status: 403, reason: 'audience' },
    ],
    [
      'a PAT for another scope than the route is refused',
      () => record({ scope: OTHER_SCOPE }),
      {},
      { status: 403, reason: 'scope_mismatch' },
    ],
    [
      'a PAT scope missing from the UTS registry is refused',
      () => record({ scope: 'session-ingest:admin' }),
      { scope: 'session-ingest:admin' },
      { status: 403, reason: 'scope_unknown' },
    ],
    [
      'a PAT for a scope that is not PAT-eligible is refused',
      () => record({ scope: NO_PAT_SCOPE }),
      { scope: NO_PAT_SCOPE },
      { status: 403, error: 'insufficient_scope', reason: 'pat_not_eligible' },
    ],
    [
      'a PAT on a session-bound scope is refused',
      () => record({ scope: SESSION_SCOPE }),
      { scope: SESSION_SCOPE },
      { status: 401, reason: 'session_required' },
    ],
    [
      'a PAT on a route that requires a session is refused',
      () => record(),
      { requiresSession: true },
      { status: 401, reason: 'session_required' },
    ],
    [
      'a PAT of another org is refused',
      () => record({ org: 'org-2' }),
      { org: 'org-1' },
      { status: 403, reason: 'org_mismatch' },
    ],
    [
      'a PAT of the request org is accepted',
      () => record({ org: 'org-1' }),
      { org: 'org-1' },
      { ok: true },
    ],
    [
      'a PAT without an org on an org-scoped route is accepted',
      () => record(),
      { org: 'org-1' },
      { ok: true },
    ],
  ])('%s', async (_name, held, route, expected) => {
    lookup.records.set(await hashPat(pat), held());
    expect(await verify(pat, route)).toMatchObject(expected);
  });

  it('refuses a lookup answer that does not match the record schema with 503', async () => {
    lookup.records.set(await hashPat(pat), { ...record(), scope: 'two scopes' });
    expect(await verify()).toMatchObject({
      ok: false,
      status: 503,
      reason: 'pat_lookup_unavailable',
    });
  });

  it('refuses a PAT of a blocked account', async () => {
    h.feed.list = { ...emptyList(), blockedAccounts: new Set(['user-1']) };
    expect(await verify()).toMatchObject({ ok: false, status: 401, reason: 'blocked_account' });
  });
});

describe('the client address', () => {
  it.each([
    ['no address', null],
    ['an empty address', ''],
  ])('refuses a PAT with %s: 400, no lookup, no feed fetch', async (_name, address) => {
    expect(await verify(pat, {}, h, address)).toMatchObject({
      ok: false,
      status: 400,
      error: 'invalid_request',
      reason: 'pat_client_address_missing',
    });
    expect(lookup.hashes).toEqual([]);
    expect(h.feed.calls).toBe(0);
  });

  it('needs no address for an access token', async () => {
    expect(
      await h.verifier.verify(
        bearer('not.a.token'),
        { issuer: 'uts', scope: SCOPE },
        { waitUntil: h.ctx.waitUntil, clientAddress: null }
      )
    ).toMatchObject({ status: 401, reason: 'malformed_token' });
  });

  it('is required by the type of a verifier that accepts PATs', () => {
    const uts = {
      issuer: UTS_ISSUER,
      jwks: h.utsJwks.source,
      scopeRegistry: UTS_REGISTRY,
      revocation: h.feed.source,
    };
    const withPats = createVerifier({
      audience: AUDIENCE,
      resourceMetadataUrl: RESOURCE_METADATA,
      uts: {
        ...uts,
        pat: { lookup: lookup.lookup, workload: 'w', cacheKeys: async () => ({ current: KEY_V1 }) },
      },
    });
    const tokensOnly = createVerifier({
      audience: AUDIENCE,
      resourceMetadataUrl: RESOURCE_METADATA,
      uts,
    });
    const route: Route = { issuer: 'uts', scope: SCOPE };
    const waitUntil = () => {};
    // Never called: tsgo checks these lines.
    const calls = () => [
      // @ts-expect-error a verifier that accepts PATs needs the client address
      withPats.verify(null, route, { waitUntil }),
      withPats.verify(null, route, { waitUntil, clientAddress: null }),
      tokensOnly.verify(null, route, { waitUntil }),
    ];
    expect(calls).toBeTypeOf('function');
  });
});

describe('shared-cache keys from the bundle on each access', () => {
  it('follows a rotation on a running instance', async () => {
    let keys: PatCacheKeys = { current: KEY_V1 };
    const provider = async () => keys;
    h = await instance({ cacheKeys: provider });
    const reader = await instance({ cacheKeys: provider });
    const [later, newer] = [createPatString(), createPatString()];
    lookup.records.set(await hashPat(later), record({ patId: 'pat-later' }));
    lookup.records.set(await hashPat(newer), record({ patId: 'pat-newer' }));
    await verify(pat);
    await verify(later);
    await drain(h.background);
    expect(lookup.hashes).toHaveLength(2);

    // Rotation: v2 signs, v1 still verifies. The reader serves the v1 entry from the shared cache.
    keys = { current: KEY_V2, previous: KEY_V1 };
    expect(await verify(pat, {}, reader)).toMatchObject({ ok: true });
    expect(lookup.hashes).toHaveLength(2);
    // A new entry is signed with v2.
    await verify(newer);
    await drain(h.background);
    const written = shared.entries.get(`pat:session-ingest:${await hashPat(newer)}`) ?? '{}';
    expect(JSON.parse(written)).toMatchObject({ k: 'v2' });

    // v1 leaves the bundle: its entries no longer count; v2 entries still do.
    keys = { current: KEY_V3, previous: KEY_V2 };
    expect(await verify(later, {}, reader)).toMatchObject({ ok: true });
    expect(lookup.hashes).toHaveLength(4);
    expect(await verify(newer, {}, reader)).toMatchObject({ ok: true });
    expect(lookup.hashes).toHaveLength(4);
  });

  it('counts a key provider failure as a cache miss and skips the write', async () => {
    await verify();
    await drain(h.background);
    const puts = shared.puts;
    const failing = await instance({
      cacheKeys: async () => {
        throw new Error('bundle unavailable');
      },
    });
    expect(await verify(pat, {}, failing)).toMatchObject({ ok: true });
    await drain(failing.background);
    expect(lookup.hashes).toHaveLength(2);
    expect(shared.puts).toBe(puts);
  });
});

describe('the shared-cache read on a cold instance', () => {
  it('starts alongside the feed read, and an instance hit reads nothing', async () => {
    let reads = 0;
    const get = shared.get;
    shared.get = async key => {
      reads++;
      return await get(key);
    };
    h.feed.gate = gate();
    const pending = verify();
    await vi.waitFor(() => expect(h.feed.calls).toBe(1));
    expect(reads).toBe(1);
    h.feed.gate.release();
    expect(await pending).toMatchObject({ ok: true });
    expect(await verify()).toMatchObject({ ok: true });
    expect(reads).toBe(1);
  });
});

describe('bounded bookkeeping', () => {
  const request = (address: string): PatRequest => ({
    clientAddress: address,
    waitUntil: () => {},
    scope: newCallScope(),
  });

  it('fails pending lookups past their timeout once over the bound', async () => {
    // Every timer is fake and never advanced: each owner looks like a cancelled request whose
    // lookup never settles.
    fakeAllTimers();
    const resolver = createPatResolver({
      lookup: () => Promise.withResolvers<PatLookupResult>().promise,
      workload: 'w',
      cacheKeys: async () => ({ current: KEY_V1 }),
    });
    for (let i = 0; i <= MAX_INSTANCE_ENTRIES; i++) {
      void resolver.resolve(`old-${i}`, request(`a-${i}`), null);
    }
    await vi.advanceTimersByTimeAsync(1);
    expect(resolver.sizes().pending).toBe(MAX_INSTANCE_ENTRIES + 1);
    vi.setSystemTime(Date.now() + PAT_LOOKUP_TIMEOUT_MS);
    for (let i = 0; i < 100; i++) void resolver.resolve(`new-${i}`, request(`b-${i}`), null);
    await vi.advanceTimersByTimeAsync(1);
    expect(resolver.sizes().pending).toBe(100);
  });

  it('never tracks more addresses than its bound', async () => {
    const resolver = createPatResolver({
      lookup: async () => ({ status: 'not_found' }),
      workload: 'w',
      cacheKeys: async () => ({ current: KEY_V1 }),
    });
    // All inside one second, so no window has expired.
    for (let i = 0; i < MAX_TRACKED_ADDRESSES + 500; i++) {
      await resolver.resolve(`hash-${i}`, request(`a-${i}`), null);
    }
    expect(resolver.sizes().addresses).toBe(MAX_TRACKED_ADDRESSES);
  });
});
