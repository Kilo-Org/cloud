import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { postAuth } from '@/lib/auth/auth-fetch';
import { type AdmissionPayload, clearAttestKeyOnRefusal, getAdmission } from '@/lib/auth/admission';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';

// Mock @/lib/config to avoid pulling in react-native at module import time.
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'http://localhost:3000',
}));

// The admission module needs a device runtime; stub the refusal clear and the
// proof rebuilt for the one unknown-key retry.
vi.mock('@/lib/auth/admission', () => ({
  clearAttestKeyOnRefusal: vi.fn(),
  getAdmission: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.4',
}));

/**
 * The one refusal `postAuth` repairs itself: an iOS assertion against a key id
 * the server has never stored. Every case here proves the retry is bounded —
 * one attempt, a new attestation, and no retry for any other refusal.
 */
describe('postAuth unknown-key recovery', () => {
  const storedKeyAdmission: AdmissionPayload = {
    platform: 'ios',
    kind: 'assertion',
    challenge: 'stale-challenge',
    payload: 'stale-assertion',
    keyId: 'stored-key-id',
  };
  const freshAttestation: AdmissionPayload = {
    platform: 'ios',
    kind: 'attestation',
    challenge: 'fresh-challenge',
    payload: 'fresh-attestation',
    keyId: 'fresh-key-id',
  };
  const tokenBodyWithProof = {
    provider: 'apple',
    idToken: 'apple-id-token',
    nonce: 'raw-nonce',
    supportsRefresh: true,
    admission: storedKeyAdmission,
  };
  const unknownKeyRefusal = () =>
    Response.json(
      { error: 'ADMISSION_REQUIRED', recovery: 'IOS_ASSERTION_UNKNOWN_KEY' },
      {
        status: 403,
      }
    );
  // A proof that cannot repair the refusal stays retryable and unnamed, so it
  // reads as the generic retry message, never the browser-only admission copy.
  const unnamedRetryableRefusal = {
    ok: false,
    errorCode: undefined,
    ssoOrganizationId: undefined,
    terminal: false,
  };
  const mockGetAdmission = vi.mocked(getAdmission);

  it('retries once with a freshly attested proof after an unknown-key refusal', async () => {
    mockGetAdmission.mockResolvedValue(freshAttestation);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(unknownKeyRefusal())
      .mockResolvedValueOnce(Response.json({ token: 't', refreshToken: 'r', expiresIn: 3600 }));

    const result = await postAuth('/api/auth/native/token', tokenBodyWithProof);

    expect(result).toEqual({ ok: true, data: { token: 't', refreshToken: 'r', expiresIn: 3600 } });
    // The refusal dropped the stored key id, and the retry carries the proof
    // built after that drop — a new key, not the refused one.
    expect(clearAttestKeyOnRefusal).toHaveBeenCalledWith('ADMISSION_REQUIRED');
    const retryBody: unknown = JSON.parse(z.string().parse(fetchSpy.mock.calls[1]?.[1]?.body));
    expect(retryBody).toEqual({ ...tokenBodyWithProof, admission: freshAttestation });
  });

  it('retries at most once: a second refusal is final', async () => {
    mockGetAdmission.mockResolvedValue(freshAttestation);
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(unknownKeyRefusal())
      .mockResolvedValueOnce(unknownKeyRefusal());

    const result = await postAuth('/api/auth/native/token', tokenBodyWithProof);

    expect(result).toMatchObject({ ok: false, errorCode: 'ADMISSION_REQUIRED', httpStatus: 403 });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(mockGetAdmission).toHaveBeenCalledTimes(1);
  });

  it.each<[string, string, unknown]>([
    ['no hint', '/api/auth/native/token', tokenBodyWithProof],
    [
      'an attestation body',
      '/api/auth/native/token',
      { ...tokenBodyWithProof, admission: { ...storedKeyAdmission, kind: 'attestation' } },
    ],
    [
      'an assertion without a key id',
      '/api/auth/native/token',
      { ...tokenBodyWithProof, admission: { ...storedKeyAdmission, keyId: undefined } },
    ],
    [
      'a non-iOS proof',
      '/api/auth/native/token',
      { ...tokenBodyWithProof, admission: { ...storedKeyAdmission, platform: 'android' } },
    ],
    ['no admission at all', '/api/auth/native/token', { provider: 'passkey', ticket: 'ticket-1' }],
    ['another route', '/api/auth/passkey/authenticate', tokenBodyWithProof],
  ])('leaves a refusal with %s unrecovered', async (label, path, body) => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(
        label === 'no hint'
          ? Response.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 })
          : unknownKeyRefusal()
      );

    const result = await postAuth(path as never, body);

    expect(result).toMatchObject({ ok: false, errorCode: 'ADMISSION_REQUIRED' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockGetAdmission).not.toHaveBeenCalled();
  });

  it('leaves a hint on another status and code unrecovered', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json(
        { error: 'INVALID_TOKEN', recovery: 'IOS_ASSERTION_UNKNOWN_KEY' },
        {
          status: 401,
        }
      )
    );

    const result = await postAuth('/api/auth/native/token', tokenBodyWithProof);

    expect(result).toMatchObject({ ok: false, errorCode: 'INVALID_TOKEN', httpStatus: 401 });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => Promise<AdmissionPayload | undefined>]>([
    ['no proof', () => Promise.resolve(undefined)],
    ['the refused assertion', () => Promise.resolve(storedKeyAdmission)],
    [
      'an assertion against another key',
      () => Promise.resolve({ ...storedKeyAdmission, keyId: 'other' }),
    ],
    [
      'a non-iOS proof',
      () =>
        Promise.resolve({
          platform: 'android' as const,
          kind: 'assertion' as const,
          challenge: 'c',
          payload: 'p',
        }),
    ],
    ['a producer that throws', () => Promise.reject(new Error('admission_challenge_failed'))],
  ])('never sends the retry when the fresh proof is %s', async (_label, produce) => {
    mockGetAdmission.mockImplementation(produce);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(unknownKeyRefusal());

    const result = await postAuth('/api/auth/native/token', tokenBodyWithProof);

    expect(result).toEqual(unnamedRetryableRefusal);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('files no terminal event for a refusal it repaired', async () => {
    const events: TelemetryEvent[] = [];
    setTelemetrySink(event => {
      events.push(event);
    });
    mockGetAdmission.mockResolvedValue(freshAttestation);
    vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(unknownKeyRefusal())
      .mockResolvedValueOnce(Response.json({ token: 't', refreshToken: 'r', expiresIn: 3600 }));
    try {
      await postAuth('/api/auth/native/token', tokenBodyWithProof);
    } finally {
      setTelemetrySink(null);
    }

    expect(events).toEqual([]);
  });
});
