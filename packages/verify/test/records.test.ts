import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS,
  FEED_WAIT_AFTER_MS,
  createVerifier,
  type BrowserSessionRecord,
  type RecordCheckResult,
  type UtsTokenRecord,
} from '../src/index';
import {
  AUDIENCE,
  RESOURCE_METADATA,
  STS_ISSUER,
  UTS_FEED_KID,
  emptyList,
  fakeJwks,
  harness,
  nowSeconds,
  type Harness,
} from './helpers';

// The narrow record checks (coordination p2 final, browser session and Pages capability): one
// table row per rule, then the fail-closed cases.

const SUB = 'user-1';
const SID = '0b6f2c1e-3d4a-4f5b-8c6d-7e8f9a0b1c2d';
const OTHER_SID = '1c7a3d2f-4e5b-4a6c-9d7e-8f9a0b1c2d3e';

type Method = {
  name: 'checkBrowserSession' | 'checkUtsTokenRecord';
  invalid: 'invalid_session_record' | 'invalid_record';
  /** A valid record for this method, issued 10 s ago. */
  record: (h: Harness) => Record<string, unknown>;
  check: (h: Harness, record: Record<string, unknown>) => Promise<RecordCheckResult>;
};

// Test inputs reach the methods with their wrong types on purpose: the methods validate at runtime.
const browser: Method = {
  name: 'checkBrowserSession',
  invalid: 'invalid_session_record',
  record: () => ({ sub: SUB, sid: SID, issuedAt: nowSeconds() - 10 }),
  check: (h, record) =>
    h.verifier.checkBrowserSession(record as unknown as BrowserSessionRecord, h.ctx),
};

const utsToken: Method = {
  name: 'checkUtsTokenRecord',
  invalid: 'invalid_record',
  record: h => ({ sub: SUB, sid: SID, issuedAt: nowSeconds() - 10, kid: h.uts.kid }),
  check: (h, record) => h.verifier.checkUtsTokenRecord(record as unknown as UtsTokenRecord, h.ctx),
};

type Expected = 'ok' | 'invalid' | 'revoked_session' | 'account_blocked' | 'revoked_key';

type Case = {
  name: string;
  /** Changes to the method's valid record; `undefined` removes the field. */
  change?: (record: Record<string, unknown>, h: Harness) => Record<string, unknown>;
  setup?: (h: Harness, record: Record<string, unknown>) => void;
  expected: Expected;
};

let h: Harness;
beforeEach(async () => {
  h = await harness();
});

function table(method: Method, cases: Case[]): void {
  it.each(cases.map(c => [c.name, c] as const))('%s', async (_name, c) => {
    const base = method.record(h);
    const record = c.change === undefined ? base : { ...base, ...c.change(base, h) };
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) delete record[key];
    }
    c.setup?.(h, record);
    const result = await method.check(h, record);
    switch (c.expected) {
      case 'ok':
        // Exactly this: a record check grants nothing.
        expect(result).toEqual({ ok: true });
        return;
      case 'invalid':
        expect(result).toEqual({ ok: false, status: 401, reason: method.invalid });
        // Malformed input touches neither the key set nor the feed.
        expect(h.utsJwks.calls).toBe(0);
        expect(h.feed.calls).toBe(0);
        return;
      default:
        expect(result).toEqual({ ok: false, status: 401, reason: c.expected });
    }
  });
}

const list = (h: Harness, change: Partial<Harness['feed']['list']>): void => {
  h.feed.list = { ...emptyList(), ...change };
};

const sessionRule: Case[] = [
  { name: 'a live session is accepted', expected: 'ok' },
  {
    name: 'a sid in revoked_sids is revoked',
    setup: h => list(h, { revokedSids: new Set([SID]) }),
    expected: 'revoked_session',
  },
  {
    name: 'another sid in revoked_sids does not count',
    setup: h => list(h, { revokedSids: new Set([OTHER_SID]) }),
    expected: 'ok',
  },
  {
    name: 'revoked_before equal to issuedAt revokes',
    setup: (h, r) => list(h, { revokedBefore: new Map([[SUB, Number(r.issuedAt)]]) }),
    expected: 'revoked_session',
  },
  {
    name: 'revoked_before after issuedAt revokes',
    setup: (h, r) => list(h, { revokedBefore: new Map([[SUB, Number(r.issuedAt) + 1]]) }),
    expected: 'revoked_session',
  },
  {
    name: 'revoked_before before issuedAt does not revoke',
    setup: (h, r) => list(h, { revokedBefore: new Map([[SUB, Number(r.issuedAt) - 1]]) }),
    expected: 'ok',
  },
  {
    name: "another subject's revoked_before does not count",
    setup: (h, r) => list(h, { revokedBefore: new Map([['user-2', Number(r.issuedAt) + 1]]) }),
    expected: 'ok',
  },
  {
    name: 'a blocked account is refused',
    setup: h => list(h, { blockedAccounts: new Set([SUB]) }),
    expected: 'account_blocked',
  },
  {
    name: 'another blocked account does not count',
    setup: h => list(h, { blockedAccounts: new Set(['user-2']) }),
    expected: 'ok',
  },
];

const validation: Case[] = [
  {
    name: 'a 255-character sub is accepted',
    change: () => ({ sub: 'a'.repeat(255) }),
    expected: 'ok',
  },
  { name: 'an empty sub is refused', change: () => ({ sub: '' }), expected: 'invalid' },
  {
    name: 'a 256-character sub is refused',
    change: () => ({ sub: 'a'.repeat(256) }),
    expected: 'invalid',
  },
  {
    name: 'a sub that is not a string is refused',
    change: () => ({ sub: 7 }),
    expected: 'invalid',
  },
  { name: 'a missing sub is refused', change: () => ({ sub: undefined }), expected: 'invalid' },
  {
    name: 'an uppercase UUID sid is refused',
    change: () => ({ sid: SID.toUpperCase() }),
    expected: 'invalid',
  },
  {
    name: 'a sid that is not a UUID is refused',
    change: () => ({ sid: 'grant-1' }),
    expected: 'invalid',
  },
  {
    name: 'a braced UUID sid is refused',
    change: () => ({ sid: `{${SID}}` }),
    expected: 'invalid',
  },
  { name: 'a missing sid is refused', change: () => ({ sid: undefined }), expected: 'invalid' },
  { name: 'issuedAt 0 is refused', change: () => ({ issuedAt: 0 }), expected: 'invalid' },
  { name: 'a negative issuedAt is refused', change: () => ({ issuedAt: -1 }), expected: 'invalid' },
  {
    name: 'a fractional issuedAt is refused',
    change: () => ({ issuedAt: nowSeconds() - 0.5 }),
    expected: 'invalid',
  },
  {
    name: 'a NaN issuedAt is refused',
    change: () => ({ issuedAt: Number.NaN }),
    expected: 'invalid',
  },
  {
    name: 'an infinite issuedAt is refused',
    change: () => ({ issuedAt: Number.POSITIVE_INFINITY }),
    expected: 'invalid',
  },
  {
    name: 'an issuedAt in milliseconds is refused',
    change: () => ({ issuedAt: Date.now() }),
    expected: 'invalid',
  },
  {
    name: 'an issuedAt that is a string is refused',
    change: () => ({ issuedAt: String(nowSeconds()) }),
    expected: 'invalid',
  },
  {
    name: 'a missing issuedAt is refused',
    change: () => ({ issuedAt: undefined }),
    expected: 'invalid',
  },
  {
    name: 'an issuedAt 60 s in the future is accepted',
    change: () => ({ issuedAt: nowSeconds() + 60 }),
    expected: 'ok',
  },
  {
    name: 'an issuedAt 61 s in the future is refused',
    change: () => ({ issuedAt: nowSeconds() + 61 }),
    expected: 'invalid',
  },
];

describe('checkBrowserSession', () => {
  describe('the session rule', () => table(browser, sessionRule));
  describe('validation', () => table(browser, validation));
  describe('no kid', () =>
    table(browser, [
      {
        name: 'a revoked key does not refuse a session record, which names none',
        setup: h => list(h, { revokedKids: new Set([h.uts.kid]) }),
        expected: 'ok',
      },
    ]));
});

describe('checkUtsTokenRecord', () => {
  describe('the session rule', () => table(utsToken, sessionRule));
  describe('validation', () => table(utsToken, validation));
  describe('the signing key', () =>
    table(utsToken, [
      {
        name: 'a kid without the uts-token- prefix is refused',
        change: () => ({ kid: 'sts-key-1' }),
        expected: 'invalid',
      },
      {
        name: 'a feed key kid is refused',
        change: () => ({ kid: `${UTS_FEED_KID}abc` }),
        expected: 'invalid',
      },
      { name: 'a missing kid is refused', change: () => ({ kid: undefined }), expected: 'invalid' },
      {
        name: 'a kid in revoked_kids is refused',
        setup: (h, r) => list(h, { revokedKids: new Set([String(r.kid)]) }),
        expected: 'revoked_key',
      },
      {
        name: 'another kid in revoked_kids does not count',
        setup: h => list(h, { revokedKids: new Set([`${h.uts.kid}-old`]) }),
        expected: 'ok',
      },
      {
        name: 'a revoked key is named before a revoked session',
        setup: (h, r) =>
          list(h, { revokedKids: new Set([String(r.kid)]), revokedSids: new Set([SID]) }),
        expected: 'revoked_key',
      },
    ]));
});

const UNAVAILABLE = { ok: false, status: 503, reason: 'revocation_unavailable' };

describe.each([browser, utsToken])('$name fails closed', method => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('refuses with 503 while a cold verifier cannot fetch the feed', async () => {
    h.feed.mode = 'fail';
    expect(await method.check(h, method.record(h))).toEqual(UNAVAILABLE);
  });

  it('refuses with 503 while a cold verifier cannot fetch the key set the head verifies under', async () => {
    h.utsJwks.mode = 'fail';
    expect(await method.check(h, method.record(h))).toEqual(UNAVAILABLE);
    expect(h.feed.calls).toBe(0);
  });

  it('refuses with 503 while the bootstrap endpoint is down', async () => {
    h = await harness({ bootstrap: true });
    h.bootstrap.mode = 'fail';
    expect(await method.check(h, method.record(h))).toEqual(UNAVAILABLE);
  });

  it('loads a cold verifier through the bootstrap endpoint, in one call', async () => {
    h = await harness({ bootstrap: true });
    expect(await method.check(h, method.record(h))).toEqual({ ok: true });
    expect(h.bootstrap.calls).toBe(1);
    expect(h.utsJwks.calls).toBe(0);
    expect(h.feed.calls).toBe(0);
  });

  it('accepts a held head up to 60 s old and refuses an older one', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
    h = await harness();
    expect(await method.check(h, method.record(h))).toEqual({ ok: true });
    h.feed.mode = 'fail';
    vi.setSystemTime(Date.now() + FEED_LONG_CREDENTIAL_MAX_HEAD_AGE_MS);
    expect(await method.check(h, method.record(h))).toEqual({ ok: true });
    vi.setSystemTime(Date.now() + 1);
    expect(await method.check(h, method.record(h))).toEqual(UNAVAILABLE);
  });

  it('decides on the refreshed copy once the held head is over 30 s old', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
    h = await harness();
    expect(await method.check(h, method.record(h))).toEqual({ ok: true });
    list(h, { revokedSids: new Set([SID]) });
    vi.setSystemTime(Date.now() + FEED_WAIT_AFTER_MS + 1);
    expect(await method.check(h, method.record(h))).toEqual({
      ok: false,
      status: 401,
      reason: 'revoked_session',
    });
    expect(h.feed.calls).toBe(2);
  });

  it('makes no fetch on a warm verifier', async () => {
    expect(await method.check(h, method.record(h))).toEqual({ ok: true });
    const fetches = [h.utsJwks.calls, h.feed.calls];
    expect(await method.check(h, method.record(h))).toEqual({ ok: true });
    expect([h.utsJwks.calls, h.feed.calls]).toEqual(fetches);
  });
});

describe('a verifier without a UTS issuer', () => {
  const verifier = createVerifier({
    audience: AUDIENCE,
    environment: 'production',
    resourceMetadataUrl: RESOURCE_METADATA,
    sts: { issuer: STS_ISSUER, jwks: fakeJwks([]).source },
  });
  const ctx = { waitUntil: () => {} };

  it('rejects a record check as a programming error', async () => {
    await expect(
      verifier.checkBrowserSession({ sub: SUB, sid: SID, issuedAt: nowSeconds() }, ctx)
    ).rejects.toThrow('no uts');
    await expect(
      verifier.checkUtsTokenRecord(
        { sub: SUB, sid: SID, issuedAt: nowSeconds(), kid: 'uts-token-00-x' },
        ctx
      )
    ).rejects.toThrow('no uts');
  });
});
