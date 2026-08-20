/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN hooks under vitest (node env, no jsdom) */
/* eslint-disable max-lines -- the SSO recovery and created-account announcement suites share one hook harness */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

import { ADMISSION_CHALLENGE_FAILED, getAdmission } from '@/lib/auth/admission';
import type * as AdmissionTypes from '@/lib/auth/admission';
import type * as AuthFetchTypes from '@/lib/auth/auth-fetch';

import {
  buildChallengeEntry,
  type ChallengeEntry,
  parseEmailCodeResponse,
  parseTokenPair,
  parseTokenResponse,
  selectChallengeId,
} from '@/lib/auth/native-auth-contract';

// Mock @/lib/config to avoid pulling in react-native at module import time.
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'http://localhost:3000',
  GOOGLE_IOS_CLIENT_ID: 'ios-client-id',
  GOOGLE_WEB_CLIENT_ID: 'web-client-id',
}));

// Mock react-native Platform for admission module import.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.4',
}));

// The admission module is imported for real (importOriginal), and these native
// modules would pull in expo-modules-core, which needs a device runtime.
vi.mock('@expo/app-integrity', () => ({
  isSupported: false,
  generateKeyAsync: vi.fn(),
  attestKeyAsync: vi.fn(),
  generateAssertionAsync: vi.fn(),
  prepareIntegrityTokenProviderAsync: vi.fn(),
  requestIntegrityCheckAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));

// Mock dependencies of use-native-auth.ts so we can import production helpers.
vi.mock('expo-apple-authentication', () => ({
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  formatFullName: vi.fn(),
  signInAsync: vi.fn(),
}));

vi.mock('@react-native-google-signin/google-signin', () => ({
  GoogleSignin: { configure: vi.fn(), hasPlayServices: vi.fn(), signIn: vi.fn() },
}));

vi.mock('sonner-native', () => ({
  toast: { error: vi.fn() },
}));

vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 1 },
  digestStringAsync: vi.fn(),
  getRandomBytesAsync: vi.fn(),
}));

vi.mock('@/lib/auth/auth-context', () => ({
  useAuth: vi.fn(() => ({ signIn: vi.fn() })),
}));

// Mock getAdmission so resolveAdmission tests can control the three paths:
// success with payload, success with undefined, and throw.
vi.mock('@/lib/auth/admission', async importOriginal => {
  const mod = await importOriginal<typeof AdmissionTypes>();
  return {
    ...mod,
    getAdmission: vi.fn(),
  };
});

// useSsoRecovery reports the organization id to Sentry; stub the SDK so the
// hook can be mounted without a native runtime.
vi.mock('@sentry/react-native', () => ({
  addBreadcrumb: vi.fn(),
}));

// postAuth is the single fetch boundary for native auth; stub it so the SSO
// recovery path can be driven without a network.
vi.mock('@/lib/auth/auth-fetch', async importOriginal => {
  const mod = await importOriginal<typeof AuthFetchTypes>();
  return {
    ...mod,
    postAuth: vi.fn(),
  };
});

// ── Imports (all after vi.mock hoisting) ───────────────────────────────

const { AUTH_ERROR_MESSAGES, DEFAULT_ERROR_MESSAGE, mapError, RETRYABLE_ADMISSION_ERROR } =
  await import('@/lib/auth/auth-error-messages');

const { resolveAdmission } = await import('@/lib/auth/resolve-admission');

const { GOOGLE_WEB_CLIENT_ID } = await import('@/lib/config');
const { toast } = await import('sonner-native');
const { announcingToast } = await import('@/lib/a11y/announcing-toast');

const mockGetAdmission = vi.mocked(getAdmission);

const { useNativeAuth } = await import('@/lib/auth/use-native-auth');
const { postAuth } = await import('@/lib/auth/auth-fetch');
const mockPostAuth = vi.mocked(postAuth);

// ── C12: Config invariant ────────────────────────────────────────────────

describe('Google sign-in configuration', () => {
  it('GOOGLE_WEB_CLIENT_ID equals the expected web client ID', () => {
    expect(GOOGLE_WEB_CLIENT_ID).toBe('web-client-id');
  });
});

// ── Contract utility tests ───────────────────────────────────────────────

describe('native-auth-contract (used by use-native-auth)', () => {
  describe('parseEmailCodeResponse', () => {
    it('accepts a response without challengeId (backward-compatible with older servers)', () => {
      const result = parseEmailCodeResponse({ success: true });
      expect(result).toEqual({ success: true, challengeId: undefined });
    });

    it('accepts a response with a valid challengeId', () => {
      const result = parseEmailCodeResponse({
        success: true,
        challengeId: 'abcd1234-5678-4def-8123-456789abcdef',
      });
      expect(result).toEqual({
        success: true,
        challengeId: 'abcd1234-5678-4def-8123-456789abcdef',
      });
    });

    it('rejects an invalid challengeId format', () => {
      expect(parseEmailCodeResponse({ success: true, challengeId: 'not-a-uuid' })).toBeNull();
    });

    it('rejects a non-success response', () => {
      expect(parseEmailCodeResponse({ success: false })).toBeNull();
    });

    it('rejects null/undefined', () => {
      expect(parseEmailCodeResponse(null)).toBeNull();
      expect(parseEmailCodeResponse(undefined)).toBeNull();
    });
  });

  describe('parseTokenResponse', () => {
    it('parses a valid token', () => {
      expect(parseTokenResponse({ token: 'jwt-token' })).toEqual({ token: 'jwt-token' });
    });

    it('rejects missing token', () => {
      expect(parseTokenResponse({})).toBeNull();
    });

    it('rejects null', () => {
      expect(parseTokenResponse(null)).toBeNull();
    });
  });

  describe('parseTokenPair', () => {
    it('parses a full token pair with refresh (Apple/Google/Email after supportsRefresh:true)', () => {
      const result = parseTokenPair({ token: 'at', refreshToken: 'rt', expiresIn: 3600 });
      expect(result).toEqual({ token: 'at', refreshToken: 'rt', expiresIn: 3600 });
    });

    it('parses a token-only response (legacy server without refresh)', () => {
      const result = parseTokenPair({ token: 'at' });
      expect(result).toEqual({ token: 'at' });
    });

    it('returns null when token is missing', () => {
      expect(parseTokenPair({ refreshToken: 'rt' })).toBeNull();
    });

    it('returns null for non-objects', () => {
      expect(parseTokenPair(null)).toBeNull();
      expect(parseTokenPair(undefined)).toBeNull();
    });
  });
});

// ── Production error mapping ────────────────────────────────────────────

describe('use-native-auth error mapping', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ['INVALID_CODE', 'That code is incorrect. Please try again.'],
    ['TOO_MANY_ATTEMPTS', 'Too many attempts. Please request a new code.'],
    ['CODE_IN_PROGRESS', 'Your code is being processed. Wait a moment and try again.'],
    ['INVALID_EMAIL', 'Unable to deliver email to this address. Please use a different email.'],
    ['EMAIL_DELIVERY_FAILED', 'Email delivery is temporarily unavailable. Please try again later.'],
  ] as const)('maps %s to a user-facing message', (code, message) => {
    // Exercise production mapError against the production AUTH_ERROR_MESSAGES map.
    const result = mapError(code);
    expect(result).toBe(message);

    // Error messages must never contain words like "uuid" or "challenge".
    expect(result).not.toMatch(/uuid|challenge/i);
  });

  it('returns the default error message for an undefined code', () => {
    expect(mapError(undefined)).toBe(DEFAULT_ERROR_MESSAGE);
  });

  it('returns the default error message for an unknown code', () => {
    expect(mapError('NONEXISTENT_CODE')).toBe(DEFAULT_ERROR_MESSAGE);
  });

  it('has a retryable admission error constant', () => {
    expect(RETRYABLE_ADMISSION_ERROR).toBe(
      'We could not verify this device. Check your connection and try again.'
    );
    expect(RETRYABLE_ADMISSION_ERROR).toMatch(/try again/i);
  });

  it('ADMISSION_REQUIRED message includes the More sign-in options CTA', () => {
    const message = AUTH_ERROR_MESSAGES.ADMISSION_REQUIRED;
    expect(message).toContain('More sign-in options');
    // Non-retryable: must not suggest trying again.
    expect(message).not.toMatch(/try again|retry/i);
  });

  it('ADMISSION_CHALLENGE_FAILED sentinel exists for catch blocks', () => {
    expect(ADMISSION_CHALLENGE_FAILED).toBe('admission_challenge_failed');
  });
});

// ── Production resolveAdmission ─────────────────────────────────────────

describe('resolveAdmission', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns { admission } when getAdmission yields a payload', async () => {
    const payload = {
      platform: 'ios' as const,
      kind: 'attestation' as const,
      challenge: 'server-challenge',
      payload: '',
    };
    mockGetAdmission.mockResolvedValue(payload);

    const result = await resolveAdmission();
    expect(result).toEqual({ admission: payload });
  });

  it('returns { admission: undefined } when getAdmission returns undefined', async () => {
    mockGetAdmission.mockResolvedValue(undefined);

    const result = await resolveAdmission();
    expect(result).toEqual({ admission: undefined });
  });

  it('shows retryable toast and throws ADMISSION_CHALLENGE_FAILED on any error', async () => {
    mockGetAdmission.mockRejectedValue(new Error('Network error'));

    await expect(resolveAdmission()).rejects.toThrow('admission_challenge_failed');
    expect(toast.error).toHaveBeenCalledWith(RETRYABLE_ADMISSION_ERROR);
  });

  it('shows retryable toast and throws on JSON parse failure', async () => {
    mockGetAdmission.mockRejectedValue(new SyntaxError('Unexpected token'));

    await expect(resolveAdmission()).rejects.toThrow('admission_challenge_failed');
    expect(toast.error).toHaveBeenCalledWith(RETRYABLE_ADMISSION_ERROR);
  });
});

// ── Challenge binding ───────────────────────────────────────────────────

describe('challenge binding', () => {
  const email = 'user@example.com';
  const challengeId = 'c0000000-0000-4000-8000-000000000001';

  describe('buildChallengeEntry', () => {
    it('stores the challenge for the email after OTP success', () => {
      const entry = buildChallengeEntry({ success: true, challengeId }, email);
      expect(entry).toEqual({ email, challengeId });
    });

    it('returns null when the server returns no challengeId', () => {
      const entry = buildChallengeEntry({ success: true, challengeId: undefined }, email);
      expect(entry).toBeNull();
    });
  });

  describe('selectChallengeId', () => {
    const entry: ChallengeEntry = { email, challengeId };

    it('returns the challengeId when the email matches', () => {
      expect(selectChallengeId(entry, email)).toBe(challengeId);
    });

    it('returns undefined when the email changed', () => {
      expect(selectChallengeId(entry, 'other@example.com')).toBeUndefined();
    });

    it('returns undefined when the entry is null (no server challenge)', () => {
      expect(selectChallengeId(null, email)).toBeUndefined();
    });
  });
});

// ── SSO recovery (hook) ────────────────────────────────────────────────

type NativeAuthResult = ReturnType<typeof useNativeAuth>;

function NativeAuthHarness({ resultRef }: { resultRef: { current: NativeAuthResult | null } }) {
  const result = useNativeAuth();
  resultRef.current = result;
  return null;
}

async function mountNativeAuth(): Promise<{ current: NativeAuthResult | null }> {
  const resultRef: { current: NativeAuthResult | null } = { current: null };
  await act(async () => {
    TestRenderer.create(React.createElement(NativeAuthHarness, { resultRef }));
    await Promise.resolve();
  });
  return resultRef;
}

describe('useNativeAuth SSO recovery', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('exposes ssoRecovery (initially null) and clearSsoRecovery', async () => {
    const resultRef = await mountNativeAuth();
    const result = resultRef.current;

    expect(result).not.toBeNull();
    expect(result?.ssoRecovery).toBeNull();
    expect(typeof result?.clearSsoRecovery).toBe('function');
  });

  it('sets ssoRecovery on an SSO_ERROR and clears it on a new attempt', async () => {
    mockPostAuth.mockResolvedValue({
      ok: false,
      errorCode: 'SSO_ERROR',
      ssoOrganizationId: 'org_1',
    });

    const resultRef = await mountNativeAuth();
    const result = resultRef.current;
    expect(result).not.toBeNull();

    await act(async () => {
      await result?.requestEmailCode('user@example.com');
    });

    expect(resultRef.current?.ssoRecovery).toEqual({
      email: 'user@example.com',
      ssoOrganizationId: 'org_1',
    });

    // A new attempt clears the recovery state before posting.
    mockPostAuth.mockResolvedValue({ ok: true, data: { success: true } });
    await act(async () => {
      await result?.requestEmailCode('user@example.com');
    });

    expect(resultRef.current?.ssoRecovery).toBeNull();
  });
});

// ── Created-account announcement ────────────────────────────────────────

describe('useNativeAuth created-account announcement', () => {
  beforeEach(() => {
    // A prior resolveAdmission test sets a rejection that only clearAllMocks
    // (not resetAllMocks) runs; reset it so admission resolves to undefined.
    mockGetAdmission.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('announces account creation when the token response has created: true', async () => {
    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { token: 'at', refreshToken: 'rt', expiresIn: 3600, created: true },
    });

    const resultRef = await mountNativeAuth();
    const result = resultRef.current;
    expect(result).not.toBeNull();

    await act(async () => {
      await result?.verifyEmailCode('user@example.com', '123456');
    });

    expect(announcingToast.success).toHaveBeenCalledWith('Account created. Welcome to Kilo Code.');
  });

  it('stays silent when created is absent', async () => {
    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { token: 'at', refreshToken: 'rt', expiresIn: 3600 },
    });

    const resultRef = await mountNativeAuth();
    const result = resultRef.current;
    expect(result).not.toBeNull();

    await act(async () => {
      await result?.verifyEmailCode('user@example.com', '123456');
    });

    expect(announcingToast.success).not.toHaveBeenCalled();
  });

  it('stays silent when created is false', async () => {
    mockPostAuth.mockResolvedValue({
      ok: true,
      data: { token: 'at', refreshToken: 'rt', expiresIn: 3600, created: false },
    });

    const resultRef = await mountNativeAuth();
    const result = resultRef.current;
    expect(result).not.toBeNull();

    await act(async () => {
      await result?.verifyEmailCode('user@example.com', '123456');
    });

    expect(announcingToast.success).not.toHaveBeenCalled();
  });
});
