/* eslint-disable drizzle/enforce-update-with-where */
/* eslint-disable drizzle/enforce-delete-with-where */
jest.mock('@sentry/nextjs', () => ({
  captureMessage: jest.fn(),
}));

jest.mock('@vercel/firewall', () => ({
  checkRateLimit: jest.fn(),
}));

jest.mock('./native-admission-apple', () => ({
  verifyAppleAttestation: jest.fn(),
  verifyAppleAssertion: jest.fn(),
  // The digest is handed straight to the mocked verifyAppleAssertion, so its
  // value is irrelevant here. native-admission-apple.test.ts pins the actual
  // clientDataHash convention.
  appAttestClientDataHash: jest.fn(() => Buffer.alloc(32)),
}));

jest.mock('./native-admission-google', () => ({
  verifyPlayIntegrity: jest.fn(),
}));

import { describe, test, expect, beforeEach, afterEach, jest as jestGlobal } from '@jest/globals';
import {
  requireAdmissionPayload,
  countAdmissionCondition,
  resetAdmissionCountersForTests,
  validateAdmissionPayload,
  issueAdmissionChallenge,
  verifyAdmissionAsync,
  persistAttestedKey,
  DEV_SENTINEL_PAYLOAD,
  ChallengeRateLimitError,
  KeyCollisionError,
  type AdmissionPayload,
} from './native-admission';
import { captureMessage } from '@sentry/nextjs';
import { warnExceptInTest } from '@kilocode/web-shared/lib/utils.server';
import { checkRateLimit } from '@vercel/firewall';
import { verifyAppleAttestation, verifyAppleAssertion } from './native-admission-apple';
import { verifyPlayIntegrity } from './native-admission-google';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { native_attested_keys } from '@kilocode/db/schema';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core/dialect';

jest.mock('@kilocode/web-shared/lib/drizzle', () => ({
  db: {
    insert: jest.fn().mockReturnValue({
      values: jest.fn().mockReturnValue({
        onConflictDoNothing: jest.fn().mockResolvedValue(undefined),
      }),
    }),
    select: jest.fn().mockReturnValue({ from: jest.fn().mockReturnValue({ where: jest.fn() }) }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([]),
        }),
      }),
    }),
    delete: jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({ returning: jest.fn().mockResolvedValue([]) }),
    }),
    query: {
      native_attested_keys: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    },
  },
}));

jest.mock('@kilocode/web-shared/lib/utils.server', () => ({
  warnExceptInTest: jest.fn(),
}));

const mockCaptureMessage = jest.mocked(captureMessage);
const mockWarnExceptInTest = jest.mocked(warnExceptInTest);
const mockCheckRateLimit = jest.mocked(checkRateLimit);
const mockVerifyAppleAttestation = jest.mocked(verifyAppleAttestation);
const mockVerifyAppleAssertion = jest.mocked(verifyAppleAssertion);
const mockVerifyPlayIntegrity = jest.mocked(verifyPlayIntegrity);

// Helper to create a minimal NextRequest-like object for issueAdmissionChallenge
function makeRequest(): any {
  return {
    headers: new Map(),
    nextUrl: { pathname: '/api/auth/native/admission-challenge' },
  };
}

/**
 * Mock `db.update` so the challenge-consume update
 * (`native_admission_challenges`) resolves with `challengeRows` and the
 * attested-key update (`native_attested_keys`) resolves with `keyRows`.
 * Assertion tests exercise both updates, so the two must be distinguished.
 */
function mockDualUpdate(
  keyRows: unknown[],
  challengeRows: unknown[] = [{ challenge: 'ch123' }]
): void {
  jest.mocked(db.update).mockImplementation((table: unknown) => {
    if (table === native_attested_keys) {
      return {
        set: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            returning: jest.fn().mockResolvedValue(keyRows),
          }),
        }),
      } as any;
    }
    return {
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue(challengeRows),
        }),
      }),
    } as any;
  });
}

/**
 * Mock `db.update` with a stateful atomic sign-count gate: the attested-key
 * update is accepted only while `sign_count` strictly increases, mirroring the
 * DB predicate. Returns the update mock and a getter for the stored count so
 * tests can prove a stale assertion never regresses the counter.
 */
function mockAtomicSignCountGate(initialCount: number): {
  setMock: jest.Mock;
  getStored: () => number;
} {
  let stored = initialCount;
  const setMock = jest.fn().mockImplementation((setValues: { sign_count: number }) => {
    const accepted = setValues.sign_count > stored;
    if (accepted) stored = setValues.sign_count;
    return {
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue(accepted ? [{ key_id: 'key1' }] : []),
      }),
    };
  });
  jest.mocked(db.update).mockImplementation((table: unknown) => {
    if (table === native_attested_keys) {
      return { set: setMock } as any;
    }
    return {
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ challenge: 'ch123' }]),
        }),
      }),
    } as any;
  });
  return { setMock, getStored: () => stored };
}

/**
 * Mock `db.update` and capture the real conditional UPDATE that production
 * sends for the attested-key table: the `set` values and the `where`
 * predicate. The predicate is the actual Drizzle SQL object built by
 * `verifyAppleAdmission`, so tests can render it and prove the strict
 * `sign_count < asserted` clause reaches the database.
 */
function mockSignCountPredicateUpdate(keyRows: unknown[]): {
  getSet: () => Record<string, unknown> | undefined;
  getWhere: () => SQL | undefined;
} {
  let setValues: Record<string, unknown> | undefined;
  let whereCond: SQL | undefined;
  jest.mocked(db.update).mockImplementation((table: unknown) => {
    if (table === native_attested_keys) {
      return {
        set: jest.fn().mockImplementation((values: Record<string, unknown>) => {
          setValues = values;
          return {
            where: jest.fn().mockImplementation((cond: SQL) => {
              whereCond = cond;
              return { returning: jest.fn().mockResolvedValue(keyRows) };
            }),
          };
        }),
      } as any;
    }
    return {
      set: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          returning: jest.fn().mockResolvedValue([{ challenge: 'ch123' }]),
        }),
      }),
    } as any;
  });
  return { getSet: () => setValues, getWhere: () => whereCond };
}

// ── Wire contract validation ───────────────────────────────────────────────

describe('validateAdmissionPayload', () => {
  test('rejects null', () => {
    expect(validateAdmissionPayload(null)).toBeUndefined();
  });

  test('rejects non-object', () => {
    expect(validateAdmissionPayload('hello')).toBeUndefined();
  });

  test('rejects empty object', () => {
    expect(validateAdmissionPayload({})).toBeUndefined();
  });

  test('rejects missing challenge', () => {
    expect(
      validateAdmissionPayload({
        platform: 'ios',
        kind: 'attestation',
        payload: 'abc',
        keyId: 'k1',
      })
    ).toBeUndefined();
  });

  test('rejects wrong kind', () => {
    expect(
      validateAdmissionPayload({
        platform: 'ios',
        challenge: 'abc',
        kind: 'wrong',
        payload: 'abc',
        keyId: 'k1',
      })
    ).toBeUndefined();
  });

  test('rejects unknown platform', () => {
    expect(
      validateAdmissionPayload({
        platform: 'windows',
        challenge: 'abc',
        kind: 'attestation',
        payload: 'abc',
      })
    ).toBeUndefined();
  });

  test('rejects missing payload', () => {
    expect(
      validateAdmissionPayload({
        platform: 'ios',
        kind: 'attestation',
        challenge: 'abc',
        keyId: 'k1',
      })
    ).toBeUndefined();
  });

  test('rejects empty payload string', () => {
    expect(
      validateAdmissionPayload({
        platform: 'ios',
        kind: 'attestation',
        challenge: 'abc',
        payload: '',
        keyId: 'k1',
      })
    ).toBeUndefined();
  });

  test('rejects ios without keyId', () => {
    expect(
      validateAdmissionPayload({
        platform: 'ios',
        kind: 'attestation',
        challenge: 'abc',
        payload: 'data',
      })
    ).toBeUndefined();
  });

  test('rejects ios with empty keyId', () => {
    expect(
      validateAdmissionPayload({
        platform: 'ios',
        kind: 'attestation',
        challenge: 'abc',
        payload: 'data',
        keyId: '',
      })
    ).toBeUndefined();
  });

  test('accepts valid ios attestation', () => {
    const result = validateAdmissionPayload({
      platform: 'ios',
      kind: 'attestation',
      challenge: 'abc123',
      payload: 'base64data',
      keyId: 'key123',
    });
    expect(result).toBeDefined();
    expect(result?.platform).toBe('ios');
    expect(result?.kind).toBe('attestation');
    expect(result?.challenge).toBe('abc123');
    expect(result?.payload).toBe('base64data');
    expect(result?.keyId).toBe('key123');
  });

  test('accepts valid ios assertion', () => {
    const result = validateAdmissionPayload({
      platform: 'ios',
      kind: 'assertion',
      challenge: 'abc123',
      payload: 'base64assertion',
      keyId: 'key123',
    });
    expect(result).toBeDefined();
    expect(result?.kind).toBe('assertion');
  });

  test('accepts valid android attestation (no keyId needed)', () => {
    const result = validateAdmissionPayload({
      platform: 'android',
      kind: 'attestation',
      challenge: 'abc123',
      payload: 'integrityToken',
    });
    expect(result).toBeDefined();
    expect(result?.platform).toBe('android');
    expect(result?.keyId).toBeUndefined();
  });
});

// ── Proof requirement ──────────────────────────────────────────────────────

describe('requireAdmissionPayload', () => {
  test('returns the sanitized payload for a well-formed ios attestation', () => {
    expect(
      requireAdmissionPayload({
        admission: {
          platform: 'ios',
          kind: 'attestation',
          challenge: 'ch123',
          payload: 'base64data',
          keyId: 'key123',
        },
      })
    ).toEqual({
      platform: 'ios',
      kind: 'attestation',
      challenge: 'ch123',
      payload: 'base64data',
      keyId: 'key123',
    });
  });

  test('returns the sanitized payload for a well-formed android assertion', () => {
    expect(
      requireAdmissionPayload({
        admission: {
          platform: 'android',
          kind: 'assertion',
          challenge: 'ch123',
          payload: 'integrityToken',
        },
      })
    ).toEqual({
      platform: 'android',
      kind: 'assertion',
      challenge: 'ch123',
      payload: 'integrityToken',
      keyId: undefined,
    });
  });

  test('returns undefined when the field is absent', () => {
    expect(requireAdmissionPayload({ provider: 'google', idToken: 'abc' })).toBeUndefined();
  });

  test('returns undefined for a malformed payload', () => {
    expect(requireAdmissionPayload({ admission: 'garbage' })).toBeUndefined();
    expect(requireAdmissionPayload({ admission: { some: 'data' } })).toBeUndefined();
    expect(
      requireAdmissionPayload({ admission: { platform: 'ios', kind: 'assertion' } })
    ).toBeUndefined();
  });
});

// ── Challenge issuance ─────────────────────────────────────────────────────

describe('admission condition aggregation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAdmissionCountersForTests();
  });

  test('counts occurrences and emits one structured line per interval with the running count', () => {
    setMode('enforce');
    jestGlobal.spyOn(Date, 'now').mockReturnValue(1_000_000);
    try {
      checkNativeAdmission({ provider: 'google', idToken: 'a' });
      checkNativeAdmission({ provider: 'google', idToken: 'b' });
      checkNativeAdmission({ provider: 'google', idToken: 'c' });
      // Still inside the same interval: nothing flushed yet.
      expect(mockWarnExceptInTest).not.toHaveBeenCalled();

      // Next interval boundary flushes the accumulated count.
      jestGlobal.spyOn(Date, 'now').mockReturnValue(1_000_000 + 60_001);
      checkNativeAdmission({ provider: 'google', idToken: 'd' });

      expect(mockWarnExceptInTest).toHaveBeenCalledTimes(1);
      const line = JSON.parse(mockWarnExceptInTest.mock.calls[0][0] as string);
      expect(line).toMatchObject({
        event: 'native_admission_aggregate',
        metric: 'native_admission_legacy_count',
        count: 3,
        intervalMs: 60_000,
      });
    } finally {
      jestGlobal.restoreAllMocks();
    }
  });

  test('report-mode invalid shapes aggregate under their own metric', () => {
    setMode('report');
    jestGlobal.spyOn(Date, 'now').mockReturnValue(2_000_000);
    try {
      checkNativeAdmission({ admission: 'garbage' });
      checkNativeAdmission({ admission: null });

      jestGlobal.spyOn(Date, 'now').mockReturnValue(2_000_000 + 60_001);
      checkNativeAdmission({ admission: 'garbage' });

      const line = JSON.parse(mockWarnExceptInTest.mock.calls[0][0] as string);
      expect(line).toMatchObject({
        event: 'native_admission_aggregate',
        metric: 'native_admission_invalid_shape',
        count: 2,
      });
    } finally {
      jestGlobal.restoreAllMocks();
    }
  });

  test('final window flushes on later traffic even without a new counted condition', () => {
    setMode('enforce');
    jestGlobal.spyOn(Date, 'now').mockReturnValue(3_000_000);
    try {
      checkNativeAdmission({ provider: 'google', idToken: 'a' });
      // Window elapses; the next request has an admission field, so nothing
      // new is counted, but the pending window must still flush.
      jestGlobal.spyOn(Date, 'now').mockReturnValue(3_000_000 + 60_001);
      checkNativeAdmission({
        provider: 'google',
        idToken: 'b',
        admission: {
          platform: 'android',
          kind: 'assertion',
          challenge: 'ch1',
          payload: 'base64data',
          keyId: 'key1',
        },
      });

      expect(mockWarnExceptInTest).toHaveBeenCalledTimes(1);
      const line = JSON.parse(mockWarnExceptInTest.mock.calls[0][0] as string);
      expect(line).toMatchObject({
        event: 'native_admission_aggregate',
        metric: 'native_admission_legacy_count',
        count: 1,
        windowStart: new Date(3_000_000).toISOString(),
      });
    } finally {
      jestGlobal.restoreAllMocks();
    }
  });

  test('per-request captureMessage stays silent for expected conditions', () => {
    setMode('enforce');
    checkNativeAdmission({ provider: 'google', idToken: 'a' });
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});

describe('issueAdmissionChallenge', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns challenge and expiresIn in seconds', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: false });
    const mockValues = jest.fn().mockResolvedValue(undefined);
    jest.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

    const result = await issueAdmissionChallenge(makeRequest(), '127.0.0.1');
    expect(result.challenge).toEqual(expect.any(String));
    expect(result.challenge.length).toBeGreaterThan(0);
    expect(result.expiresIn).toBe(120); // 2 minutes in seconds
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      'native-admission-challenge',
      expect.objectContaining({ rateLimitKey: 'native-challenge:127.0.0.1' })
    );
  });

  test('throws ChallengeRateLimitError when rate limited', async () => {
    mockCheckRateLimit.mockResolvedValue({ rateLimited: true });

    await expect(issueAdmissionChallenge(makeRequest(), '127.0.0.1')).rejects.toThrow(
      ChallengeRateLimitError
    );
  });
});

// ── Async admission verification ───────────────────────────────────────────

describe('verifyAdmissionAsync', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns error when challenge is already consumed', async () => {
    // Simulate consumed_at already set (no rows returned from atomic update)
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    });
    jest.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const admission: AdmissionPayload = {
      platform: 'ios',
      kind: 'attestation',
      challenge: 'ch123',
      payload: 'base64data',
      keyId: 'key1',
    };
    const result = await verifyAdmissionAsync(admission);
    expect(result).toEqual({ ok: false, errorCode: 'ADMISSION_REQUIRED' });
  });

  test('returns error when challenge is expired', async () => {
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([]),
      }),
    });
    jest.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const admission: AdmissionPayload = {
      platform: 'ios',
      kind: 'attestation',
      challenge: 'ch123',
      payload: 'base64data',
      keyId: 'key1',
    };
    const result = await verifyAdmissionAsync(admission);
    expect(result).toEqual({ ok: false, errorCode: 'ADMISSION_REQUIRED' });
  });

  // ── iOS attestation ────────────────────────────────────────────────────

  test('ios attestation succeeds and returns public key', async () => {
    // Simulate successful atomic consume
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ challenge: 'ch123' }]),
      }),
    });
    jest.mocked(db.update).mockReturnValue({ set: setMock } as any);

    mockVerifyAppleAttestation.mockResolvedValue({
      ok: true,
      credentialId: Buffer.from('cred'),
      publicKeySpkiBase64: 'base64pubkey',
    });

    const admission: AdmissionPayload = {
      platform: 'ios',
      kind: 'attestation',
      challenge: 'ch123',
      payload: 'base64attest',
      keyId: 'key1',
    };
    const result = await verifyAdmissionAsync(admission);
    expect(result).toEqual({
      ok: true,
      platform: 'ios',
      keyId: 'key1',
      publicKey: 'base64pubkey',
    });
  });

  test('ios attestation returns existingKeyUserId when keyId is already bound', async () => {
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ challenge: 'ch123' }]),
      }),
    });
    jest.mocked(db.update).mockReturnValue({ set: setMock } as any);

    mockVerifyAppleAttestation.mockResolvedValue({
      ok: true,
      credentialId: Buffer.from('cred'),
      publicKeySpkiBase64: 'base64pubkey',
    });

    // KeyId already exists for a different user
    jest.mocked(db.query.native_attested_keys.findFirst).mockResolvedValue({
      key_id: 'key1',
      kilo_user_id: 'existingUser',
      platform: 'ios',
      public_key: 'base64pubkey',
      sign_count: 0,
      attested_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      last_used_at: null,
    } as any);

    const admission: AdmissionPayload = {
      platform: 'ios',
      kind: 'attestation',
      challenge: 'ch123',
      payload: 'base64attest',
      keyId: 'key1',
    };
    const result = await verifyAdmissionAsync(admission);
    expect(result).toEqual({
      ok: true,
      platform: 'ios',
      keyId: 'key1',
      publicKey: 'base64pubkey',
      existingKeyUserId: 'existingUser',
    });
  });

  test('ios attestation fails with provider error', async () => {
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ challenge: 'ch123' }]),
      }),
    });
    jest.mocked(db.update).mockReturnValue({ set: setMock } as any);

    mockVerifyAppleAttestation.mockResolvedValue({
      ok: false,
      error: 'CERT_CHAIN_INVALID',
    });

    const admission: AdmissionPayload = {
      platform: 'ios',
      kind: 'attestation',
      challenge: 'ch123',
      payload: 'base64attest',
      keyId: 'key1',
    };
    const result = await verifyAdmissionAsync(admission);
    expect(result).toEqual({ ok: false, errorCode: 'ADMISSION_REQUIRED' });
    expect(mockCaptureMessage).toHaveBeenCalledWith('apple_attestation_failed: CERT_CHAIN_INVALID');
  });

  // ── iOS assertion ──────────────────────────────────────────────────────

  test('ios assertion fails when key is unknown', async () => {
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ challenge: 'ch123' }]),
      }),
    });
    jest.mocked(db.update).mockReturnValue({ set: setMock } as any);

    // No existing key found
    jest.mocked(db.query.native_attested_keys.findFirst).mockResolvedValue(null as any);

    const admission: AdmissionPayload = {
      platform: 'ios',
      kind: 'assertion',
      challenge: 'ch123',
      payload: 'base64assertion',
      keyId: 'unknownKey',
    };
    const result = await verifyAdmissionAsync(admission);
    expect(result).toEqual({ ok: false, errorCode: 'ADMISSION_REQUIRED' });
    expect(mockCaptureMessage).toHaveBeenCalledWith('apple_assertion_unknown_key');
  });

  test('ios assertion fails when sign count is not increasing', async () => {
    // Atomic key-counter update matches zero rows: stored 10 >= asserted 5.
    mockDualUpdate([]);

    const existingKey = {
      key_id: 'key1',
      kilo_user_id: 'user1',
      platform: 'ios',
      public_key: 'base64pubkey',
      sign_count: 10,
      attested_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      last_used_at: null,
    };
    jest.mocked(db.query.native_attested_keys.findFirst).mockResolvedValue(existingKey as any);

    mockVerifyAppleAssertion.mockResolvedValue({
      ok: true,
      signCount: 5, // not greater than stored 10
    });

    const admission: AdmissionPayload = {
      platform: 'ios',
      kind: 'assertion',
      challenge: 'ch123',
      payload: 'base64assertion',
      keyId: 'key1',
    };
    const result = await verifyAdmissionAsync(admission);
    expect(result).toEqual({ ok: false, errorCode: 'ADMISSION_REQUIRED' });
    expect(mockCaptureMessage).toHaveBeenCalledWith(
      'apple_assertion_stale_or_replayed: asserted 5 rejected'
    );
  });

  test('ios assertion succeeds and proves the database sign_count < asserted predicate', async () => {
    // Capture the real conditional UPDATE production sends to the database:
    // stored 10 < asserted 11 matches the row. The predicate is rendered SQL,
    // not a JavaScript model, so this test fails if the strict `<` clause is
    // removed or weakened (for example to `<=`).
    const { getSet, getWhere } = mockSignCountPredicateUpdate([{ key_id: 'key1' }]);

    const existingKey = {
      key_id: 'key1',
      kilo_user_id: 'user1',
      platform: 'ios',
      public_key: 'base64pubkey',
      sign_count: 10,
      attested_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      last_used_at: null,
    };
    jest.mocked(db.query.native_attested_keys.findFirst).mockResolvedValue(existingKey as any);

    mockVerifyAppleAssertion.mockResolvedValue({
      ok: true,
      signCount: 11,
    });

    const admission: AdmissionPayload = {
      platform: 'ios',
      kind: 'assertion',
      challenge: 'ch123',
      payload: 'base64assertion',
      keyId: 'key1',
    };
    const result = await verifyAdmissionAsync(admission);
    expect(result).toEqual({
      ok: true,
      platform: 'ios',
      keyId: 'key1',
      signCount: 11,
      existingKeyUserId: 'user1',
    });

    // Verification advances the counter in the same conditional update.
    expect(getSet()).toEqual({ sign_count: 11 });

    // The strict `<` clause must reach the database: the rendered predicate
    // contains `"sign_count" < $N` bound to the asserted count.
    const { sql, params } = new PgDialect().sqlToQuery(getWhere()!);
    const signCountPredicate = /"sign_count"\s*<\s*\$(\d+)/.exec(sql);
    expect(signCountPredicate).not.toBeNull();
    expect(params[Number(signCountPredicate![1]) - 1]).toBe(11);
  });

  // ── iOS assertion: concurrency and monotonicity ─────────────────────────

  test('two concurrent assertions for the same sign count cannot both be accepted', async () => {
    const { setMock, getStored } = mockAtomicSignCountGate(10);

    const existingKey = {
      key_id: 'key1',
      kilo_user_id: 'user1',
      platform: 'ios',
      public_key: 'base64pubkey',
      sign_count: 10,
      attested_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      last_used_at: null,
    };
    jest.mocked(db.query.native_attested_keys.findFirst).mockResolvedValue(existingKey as any);
    mockVerifyAppleAssertion.mockResolvedValue({ ok: true, signCount: 11 });

    const admission: AdmissionPayload = {
      platform: 'ios',
      kind: 'assertion',
      challenge: 'ch123',
      payload: 'base64assertion',
      keyId: 'key1',
    };

    // Both assertions verify the same authenticator and race for the same
    // counter. The DB gate admits exactly one; the loser sees zero rows.
    const [first, second] = await Promise.all([
      verifyAdmissionAsync(admission),
      verifyAdmissionAsync(admission),
    ]);

    expect([first, second].filter(r => r.ok)).toHaveLength(1);
    expect(setMock).toHaveBeenCalledTimes(2);
    expect(getStored()).toBe(11);
  });

  test('a lower or equal sign count cannot overwrite a higher stored count', async () => {
    // A concurrent assertion already advanced the counter to 12.
    const { setMock, getStored } = mockAtomicSignCountGate(12);

    const existingKey = {
      key_id: 'key1',
      kilo_user_id: 'user1',
      platform: 'ios',
      public_key: 'base64pubkey',
      sign_count: 12,
      attested_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      last_used_at: null,
    };
    jest.mocked(db.query.native_attested_keys.findFirst).mockResolvedValue(existingKey as any);

    for (const staleCount of [11, 12]) {
      mockVerifyAppleAssertion.mockResolvedValue({ ok: true, signCount: staleCount });

      const admission: AdmissionPayload = {
        platform: 'ios',
        kind: 'assertion',
        challenge: 'ch123',
        payload: 'base64assertion',
        keyId: 'key1',
      };
      const result = await verifyAdmissionAsync(admission);
      expect(result).toEqual({ ok: false, errorCode: 'ADMISSION_REQUIRED' });
      expect(mockCaptureMessage).toHaveBeenCalledWith(
        `apple_assertion_stale_or_replayed: asserted ${staleCount} rejected`
      );
      // The higher stored count is never overwritten.
      expect(getStored()).toBe(12);
    }
    expect(setMock).toHaveBeenCalledTimes(2);
  });

  // ── Android ─────────────────────────────────────────────────────────────

  test('android assertion succeeds', async () => {
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ challenge: 'ch123' }]),
      }),
    });
    jest.mocked(db.update).mockReturnValue({ set: setMock } as any);

    mockVerifyPlayIntegrity.mockResolvedValue({
      ok: true,
      packageName: 'com.kilocode.app',
    });

    const admission: AdmissionPayload = {
      platform: 'android',
      kind: 'assertion',
      challenge: 'ch123',
      payload: 'integrityToken',
    };
    const result = await verifyAdmissionAsync(admission);
    expect(result).toEqual({
      ok: true,
      platform: 'android',
      keyId: '',
    });
  });

  test('android fails with provider error', async () => {
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ challenge: 'ch123' }]),
      }),
    });
    jest.mocked(db.update).mockReturnValue({ set: setMock } as any);

    mockVerifyPlayIntegrity.mockResolvedValue({
      ok: false,
      error: 'DEVICE_NOT_RECOGNIZED',
    });

    const admission: AdmissionPayload = {
      platform: 'android',
      kind: 'assertion',
      challenge: 'ch123',
      payload: 'integrityToken',
    };
    const result = await verifyAdmissionAsync(admission);
    expect(result).toEqual({ ok: false, errorCode: 'ADMISSION_REQUIRED' });
  });

  test('android attestation kind is refused', async () => {
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ challenge: 'ch123' }]),
      }),
    });
    jest.mocked(db.update).mockReturnValue({ set: setMock } as any);

    const admission: AdmissionPayload = {
      platform: 'android',
      kind: 'attestation',
      challenge: 'ch123',
      payload: 'integrityToken',
    };
    const result = await verifyAdmissionAsync(admission);
    expect(result).toEqual({ ok: false, errorCode: 'ADMISSION_REQUIRED' });
  });
});

// ── Key persistence ────────────────────────────────────────────────────────

describe('persistAttestedKey', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('inserts new key on attestation', async () => {
    const mockOnConflict = jest.fn().mockResolvedValue(undefined);
    const mockValues = jest.fn().mockReturnValue({ onConflictDoNothing: mockOnConflict });
    jest.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

    // Simulate findFirst returning the inserted key
    jest.mocked(db.query.native_attested_keys.findFirst).mockResolvedValue({
      key_id: 'key1',
      kilo_user_id: 'user1',
      platform: 'ios',
      public_key: 'base64pubkey',
      sign_count: 0,
      attested_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      last_used_at: null,
    } as any);

    await persistAttestedKey('user1', {
      ok: true,
      platform: 'ios',
      keyId: 'key1',
      publicKey: 'base64pubkey',
    });
  });

  test('throws on cross-user key collision', async () => {
    const mockOnConflict = jest.fn().mockResolvedValue(undefined);
    const mockValues = jest.fn().mockReturnValue({ onConflictDoNothing: mockOnConflict });
    jest.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

    // Key exists but for a different user
    jest.mocked(db.query.native_attested_keys.findFirst).mockResolvedValue({
      key_id: 'key1',
      kilo_user_id: 'otherUser',
      platform: 'ios',
      public_key: 'base64pubkey',
      sign_count: 0,
      attested_at: '2026-01-01T00:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      last_used_at: null,
    } as any);

    await expect(
      persistAttestedKey('user1', {
        ok: true,
        platform: 'ios',
        keyId: 'key1',
        publicKey: 'base64pubkey',
      })
    ).rejects.toThrow(KeyCollisionError);
  });

  test('refreshes last_used_at on assertion without rewriting the sign count', async () => {
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockResolvedValue(undefined),
    });
    jest.mocked(db.update).mockReturnValue({ set: setMock } as any);

    await persistAttestedKey('user1', {
      ok: true,
      platform: 'ios',
      keyId: 'key1',
      signCount: 15,
    });

    // The counter was bumped atomically during verification; persistence must
    // only touch last_used_at so a stale assertion cannot regress it.
    expect(setMock).toHaveBeenCalledWith({ last_used_at: expect.any(String) });
    expect(setMock.mock.calls[0]?.[0]).not.toHaveProperty('sign_count');
  });

  test('skips persistence for Android (no key tracking)', async () => {
    const mockOnConflict = jest.fn();
    const mockValues = jest.fn().mockReturnValue({ onConflictDoNothing: mockOnConflict });
    jest.mocked(db.insert).mockReturnValue({ values: mockValues } as any);

    await persistAttestedKey('user1', {
      ok: true,
      platform: 'android',
      keyId: '',
    });

    // Should not attempt insert or update
    expect(mockValues).not.toHaveBeenCalled();
  });
});

// ── Expected-condition telemetry ───────────────────────────────────────────

describe('countAdmissionCondition', () => {
  afterEach(() => {
    resetAdmissionCountersForTests();
    jestGlobal.restoreAllMocks();
  });

  test('aggregates a refusal instead of emitting one Sentry event per request', () => {
    jestGlobal.spyOn(Date, 'now').mockReturnValue(1_000_000);

    countAdmissionCondition('native_admission_refused');
    countAdmissionCondition('native_admission_refused');
    countAdmissionCondition('native_admission_refused');

    // Refusals are ordinary hostile traffic: one window line, no Sentry issue.
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });

  test('rolls the window forward on the next request after the interval', () => {
    const now = jestGlobal.spyOn(Date, 'now');

    now.mockReturnValue(1_000_000);
    countAdmissionCondition('native_admission_missing');
    now.mockReturnValue(1_000_000 + 61_000);
    expect(() => requireAdmissionPayload({})).not.toThrow();
    expect(mockCaptureMessage).not.toHaveBeenCalled();
  });
});

// ── Non-production sentinel ────────────────────────────────────────────────

describe('dev sentinel', () => {
  const admission: AdmissionPayload = {
    platform: 'android',
    kind: 'assertion',
    challenge: 'ch123',
    payload: DEV_SENTINEL_PAYLOAD,
  };
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    jest.clearAllMocks();
    mockVerifyPlayIntegrity.mockResolvedValue({ ok: true, packageName: 'com.kilocode.app' });
    const setMock = jest.fn().mockReturnValue({
      where: jest.fn().mockReturnValue({
        returning: jest.fn().mockResolvedValue([{ challenge: 'ch123' }]),
      }),
    });
    jest.mocked(db.update).mockReturnValue({ set: setMock } as any);
  });

  afterEach(() => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value: originalNodeEnv,
      writable: true,
      configurable: true,
    });
    delete process.env.NATIVE_ADMISSION_DEV_SENTINEL;
  });

  const setNodeEnv = (value: string) => {
    Object.defineProperty(process.env, 'NODE_ENV', {
      value,
      writable: true,
      configurable: true,
    });
  };

  test('accepts the sentinel outside production when the switch is on', async () => {
    setNodeEnv('development');
    process.env.NATIVE_ADMISSION_DEV_SENTINEL = 'true';

    expect(await verifyAdmissionAsync(admission)).toEqual({
      ok: true,
      platform: 'android',
      keyId: '',
    });
    expect(mockVerifyPlayIntegrity).not.toHaveBeenCalled();
  });

  test('ignores the sentinel in production', async () => {
    setNodeEnv('production');
    process.env.NATIVE_ADMISSION_DEV_SENTINEL = 'true';

    await verifyAdmissionAsync(admission);
    expect(mockVerifyPlayIntegrity).toHaveBeenCalledTimes(1);
  });

  test('ignores the sentinel when the switch is off', async () => {
    setNodeEnv('development');

    await verifyAdmissionAsync(admission);
    expect(mockVerifyPlayIntegrity).toHaveBeenCalledTimes(1);
  });

  test('sends no other payload to the sentinel branch', async () => {
    setNodeEnv('development');
    process.env.NATIVE_ADMISSION_DEV_SENTINEL = 'true';

    await verifyAdmissionAsync({ ...admission, payload: 'a-real-integrity-token' });
    expect(mockVerifyPlayIntegrity).toHaveBeenCalledTimes(1);
  });
});

// ── Cleanup ────────────────────────────────────────────────────────────────

describe('cleanupExpiredAdmissionChallenges', () => {
  test('deletes expired challenges', async () => {
    const { cleanupExpiredAdmissionChallenges } = await import('./native-admission');
    const whereMock = jest.fn().mockReturnValue({
      returning: jest.fn().mockResolvedValue([{ challenge: 'ch1' }, { challenge: 'ch2' }]),
    });
    jest.mocked(db.delete).mockReturnValue({ where: whereMock } as any);

    const count = await cleanupExpiredAdmissionChallenges();
    expect(count).toBe(2);
  });
});
