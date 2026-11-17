import { describe, expect, it } from 'vitest';

import {
  parseAuthError,
  parseDeviceAuthTokenResponse,
  parsePendingLinkOffer,
  parsePendingLinkResult,
  parseTokenPair,
} from '@/lib/auth/native-auth-contract';

const offerBody = {
  token: 'link-token',
  provider: 'github',
  email: 'person@example.com',
  methods: ['google', 'passkey'],
  emailCode: true,
  expiresAt: '2026-11-09T12:15:00.000Z',
};

describe('parsePendingLinkOffer', () => {
  it('accepts the contract shape and turns expiresAt into epoch milliseconds', () => {
    expect(parsePendingLinkOffer(offerBody)).toEqual({
      ...offerBody,
      expiresAt: Date.parse('2026-11-09T12:15:00.000Z'),
    });
  });

  it('accepts an offset timestamp and an empty method list', () => {
    expect(
      parsePendingLinkOffer({ ...offerBody, methods: [], expiresAt: '2026-11-09T13:15:00+01:00' })
    ).toMatchObject({ methods: [], expiresAt: Date.parse('2026-11-09T12:15:00.000Z') });
  });

  it.each([
    ['an empty token', { ...offerBody, token: '' }],
    ['a missing provider', { ...offerBody, provider: undefined }],
    ['a non-boolean emailCode', { ...offerBody, emailCode: 'yes' }],
    ['a method list that is not an array', { ...offerBody, methods: 'google' }],
    ['a non-ISO expiry', { ...offerBody, expiresAt: 'in 15 minutes' }],
    ['a numeric expiry', { ...offerBody, expiresAt: 1_700_000_000_000 }],
  ])('rejects %s', (_label, body) => {
    expect(parsePendingLinkOffer(body)).toBeUndefined();
  });
});

describe('parseAuthError pending link', () => {
  it('carries the offer a DIFFERENT-OAUTH refusal makes', () => {
    expect(parseAuthError({ error: 'DIFFERENT-OAUTH', pendingLink: offerBody })).toEqual({
      code: 'DIFFERENT-OAUTH',
      pendingLink: { ...offerBody, expiresAt: Date.parse(offerBody.expiresAt) },
    });
  });

  it('keeps the code and drops a malformed offer', () => {
    const parsed = parseAuthError({
      error: 'DIFFERENT-OAUTH',
      pendingLink: { ...offerBody, token: 42 },
    });
    expect(parsed).toEqual({ code: 'DIFFERENT-OAUTH' });
    expect(parsed && 'pendingLink' in parsed).toBe(false);
  });

  it('reads an older server refusal without an offer as before', () => {
    const parsed = parseAuthError({ error: 'DIFFERENT-OAUTH' });
    expect(parsed).toEqual({ code: 'DIFFERENT-OAUTH' });
    expect(parsed && 'pendingLink' in parsed).toBe(false);
  });
});

describe('parsePendingLinkResult', () => {
  it('accepts a linked result', () => {
    expect(parsePendingLinkResult({ status: 'linked', provider: 'github' })).toEqual({
      status: 'linked',
      provider: 'github',
    });
  });

  it.each([
    'EXPIRED',
    'WRONG_ACCOUNT',
    'ACCOUNT-ALREADY-LINKED',
    'PROVIDER-ALREADY-LINKED',
    'LINKING-FAILED',
  ] as const)('accepts a failed result with reason %s', reason => {
    expect(parsePendingLinkResult({ status: 'failed', reason })).toEqual({
      status: 'failed',
      reason,
    });
  });

  it('reads a reason this build does not know as a generic linking failure', () => {
    expect(parsePendingLinkResult({ status: 'failed', reason: 'SOMETHING-NEW' })).toEqual({
      status: 'failed',
      reason: 'LINKING-FAILED',
    });
  });

  it.each([
    ['an unknown status', { status: 'pending', provider: 'github' }],
    ['a linked result without a provider', { status: 'linked' }],
    ['a failed result without a reason', { status: 'failed' }],
    ['a non-object', 'linked'],
  ])('rejects %s', (_label, body) => {
    expect(parsePendingLinkResult(body)).toBeUndefined();
  });
});

describe('pending link result on a successful sign-in', () => {
  it('adds the result to a token pair', () => {
    expect(
      parseTokenPair({
        token: 'at',
        refreshToken: 'rt',
        expiresIn: 3600,
        pendingLink: { status: 'failed', reason: 'WRONG_ACCOUNT' },
      })
    ).toEqual({
      token: 'at',
      refreshToken: 'rt',
      expiresIn: 3600,
      pendingLink: { status: 'failed', reason: 'WRONG_ACCOUNT' },
    });
  });

  it('keeps the sign-in when the result is malformed', () => {
    const parsed = parseTokenPair({ token: 'at', pendingLink: { status: 'linked' } });
    expect(parsed).toEqual({ token: 'at' });
    expect(parsed && 'pendingLink' in parsed).toBe(false);
  });

  it('adds the result to an approved device-auth token', () => {
    expect(
      parseDeviceAuthTokenResponse({
        status: 'approved',
        token: 'tok',
        pendingLink: { status: 'linked', provider: 'gitlab' },
      })
    ).toEqual({
      status: 'approved',
      token: 'tok',
      pendingLink: { status: 'linked', provider: 'gitlab' },
    });
  });

  it('ignores a result on a pending device-auth poll', () => {
    expect(
      parseDeviceAuthTokenResponse({
        status: 'pending',
        pendingLink: { status: 'linked', provider: 'gitlab' },
      })
    ).toEqual({ status: 'pending' });
  });
});
