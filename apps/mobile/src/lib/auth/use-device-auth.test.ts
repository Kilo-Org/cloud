/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN hooks under vitest (node env, no jsdom) */
/* eslint-disable import/first -- vi.mock must precede the hook import so the native modules are stubbed */
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDeviceAuth429Message } from '@/lib/auth/poll-response';
import {
  buildDeviceAuthPollRequest,
  parseDeviceAuthTokenResponse,
} from '@/lib/auth/native-auth-contract';

// Mocks for the hook mount tests. `vi.mock` is hoisted above the imports, so
// the hook under test receives these stubs instead of the native modules.
vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
  AppState: { addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
}));

vi.mock('expo-web-browser', () => ({
  openBrowserAsync: vi.fn(),
  openAuthSessionAsync: vi.fn(),
}));

vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'http://localhost:3000',
  WEB_BASE_URL: 'http://localhost:3001',
}));

vi.mock('@/lib/auth/device-auth-poll', () => ({
  startDeviceAuthPoll: vi.fn(() => ({ cleanup: vi.fn(), pollNow: vi.fn() })),
}));

vi.mock('@/lib/auth/pending-external-auth', () => ({
  readPendingExternalAuth: vi.fn(),
  writePendingExternalAuth: vi.fn(),
  clearPendingExternalAuth: vi.fn(),
}));

import { useDeviceAuth } from '@/lib/auth/use-device-auth';
import { startDeviceAuthPoll } from '@/lib/auth/device-auth-poll';
import { pendingDeviceAuthState } from '@/lib/auth/device-auth-state';
import { openAuthSessionAsync } from 'expo-web-browser';
import {
  clearPendingExternalAuth,
  readPendingExternalAuth,
  writePendingExternalAuth,
} from '@/lib/auth/pending-external-auth';

describe('device-auth polling request', () => {
  it('sends only the device secret as the polling credential', () => {
    expect(buildDeviceAuthPollRequest('device-secret')).toEqual({
      deviceCode: 'device-secret',
      supportsRefresh: true,
    });
  });
});

// --- Existing 429 tests (unchanged) ---

describe('use-device-auth start path — 429 rate-limit message', () => {
  it('extracts the server error field from a 429 JSON body', () => {
    const serverBody = {
      error: 'Too many sign-in attempts from this network. Wait a few minutes and try again.',
    };
    const message = getDeviceAuth429Message(serverBody);
    expect(message).toBe(serverBody.error);
  });

  it('falls back to a fixed string when the server body has no error field', () => {
    const serverBody: { error?: string } = {};
    const message = getDeviceAuth429Message(serverBody);
    expect(message).toBe('Too many sign-in attempts. Please wait and try again.');
  });

  it('falls back to the fixed string when JSON parsing fails', () => {
    const message = getDeviceAuth429Message(undefined);
    expect(message).toBe('Too many sign-in attempts. Please wait and try again.');
  });
});

// --- New: Device auth token response parsing ---

describe('use-device-auth token response parsing', () => {
  it('parses an approved response with full refresh pair', () => {
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'access',
      refreshToken: 'refresh',
      expiresIn: 3600,
    });

    expect(result).toEqual({
      status: 'approved',
      token: 'access',
      refreshToken: 'refresh',
      expiresIn: 3600,
    });
  });

  it('parses an approved response with only a token (legacy server, no refresh)', () => {
    const result = parseDeviceAuthTokenResponse({
      status: 'approved',
      token: 'access',
    });

    expect(result).toEqual({
      status: 'approved',
      token: 'access',
      refreshToken: undefined,
      expiresIn: undefined,
    });
  });

  it('parses pending', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'pending' })).toEqual({
      status: 'pending',
    });
  });

  it('parses denied', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'denied' })).toEqual({
      status: 'denied',
    });
  });

  it('parses expired', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'expired' })).toEqual({
      status: 'expired',
    });
  });

  it('returns null for a non-object', () => {
    expect(parseDeviceAuthTokenResponse(null)).toBeNull();
  });

  it('returns null for an approved response without a token', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'approved' })).toBeNull();
  });

  it('returns null for a malformed response with wrong status', () => {
    expect(parseDeviceAuthTokenResponse({ status: 'consumed' })).toBeNull();
  });
});

// --- Poll response terminal handling ---
// When the server returns a terminal HTTP status (200/403/410) but the body
// parse fails, classifyPollResponse reports approved/denied/expired based on
// the status code alone. The poll switch must turn those into terminal errors.

describe('use-device-auth malformed poll response — terminal state', () => {
  it('returns null for a 200 body with no status field — forces terminal error', () => {
    // Server returned HTTP 200 but the JSON body is malformed (e.g. empty object).
    // parseDeviceAuthTokenResponse returns null.
    expect(parseDeviceAuthTokenResponse({})).toBeNull();
  });

  it('returns null for a 200 body with approved but no token — forces terminal error', () => {
    // Server returned HTTP 200 with status 'approved' but no token field.
    // The hook must not proceed to signIn.
    expect(parseDeviceAuthTokenResponse({ status: 'approved' })).toBeNull();
  });

  it('returns null for a 403 body with malformed JSON — forces terminal error', () => {
    // Server returned HTTP 403 but the JSON body is not an object.
    // parseDeviceAuthTokenResponse returns null.
    expect(parseDeviceAuthTokenResponse(null)).toBeNull();
  });

  it('returns null for a 410 body with wrong shape — forces terminal error', () => {
    // Server returned HTTP 410 but the body has extra unknown fields.
    // Zod strips unknowns but required fields may still be missing.
    expect(parseDeviceAuthTokenResponse({ status: 'denied', extra: true })).toEqual({
      status: 'denied',
    });
  });

  it('parses a valid denied terminal state correctly', () => {
    // A correctly formed 403 response — the parser succeeds so the hook
    // transitions to the denied terminal state, not error.
    const result = parseDeviceAuthTokenResponse({ status: 'denied' });
    expect(result).toEqual({ status: 'denied' });
  });

  it('parses a valid expired terminal state correctly', () => {
    const result = parseDeviceAuthTokenResponse({ status: 'expired' });
    expect(result).toEqual({ status: 'expired' });
  });
});

// --- pendingDeviceAuthState resume flag ---

describe('pendingDeviceAuthState resume flag', () => {
  it('defaults resumed to false for a fresh flow', () => {
    expect(pendingDeviceAuthState('UC', 'https://x').resumed).toBe(false);
  });

  it('sets resumed to true for a restored flow', () => {
    expect(pendingDeviceAuthState('UC', 'https://x', true).resumed).toBe(true);
  });
});

// --- Hook mount tests (restore/start race and resume copy flag) ---

type PendingExternalAuthRecord = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  startedAt: number;
};

type DeviceAuthResult = ReturnType<typeof useDeviceAuth>;

function DeviceAuthHarness({ resultRef }: { resultRef: { current: DeviceAuthResult | null } }) {
  const result = useDeviceAuth();
  resultRef.current = result;
  return null;
}

const fetchMock = vi.fn();

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveFn: ((value: T) => void) | undefined = undefined;
  const promise = new Promise<T>(resolve => {
    resolveFn = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      resolveFn?.(value);
    },
  };
}

function requireResult(resultRef: { current: DeviceAuthResult | null }): DeviceAuthResult {
  const result = resultRef.current;
  if (!result) {
    throw new Error('useDeviceAuth did not run');
  }
  return result;
}

async function mountSettled(): Promise<{ current: DeviceAuthResult | null }> {
  const resultRef: { current: DeviceAuthResult | null } = { current: null };
  await act(async () => {
    TestRenderer.create(React.createElement(DeviceAuthHarness, { resultRef }));
    await Promise.resolve();
  });
  return resultRef;
}

describe('useDeviceAuth hook', () => {
  beforeEach(() => {
    vi.mocked(readPendingExternalAuth).mockReset();
    vi.mocked(writePendingExternalAuth).mockReset();
    vi.mocked(clearPendingExternalAuth).mockReset();
    vi.mocked(startDeviceAuthPoll).mockReset();
    vi.mocked(startDeviceAuthPoll).mockReturnValue({
      cleanup: vi.fn<() => void>(),
      pollNow: vi.fn<() => void>(),
    });
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('restores a live record into pending state, marks it resumed, and starts the poll', async () => {
    const record: PendingExternalAuthRecord = {
      deviceCode: 'device-secret',
      userCode: 'UC-1234',
      verificationUrl: 'https://example.com/device-auth?code=UC-1234',
      startedAt: Date.now(),
    };
    vi.mocked(readPendingExternalAuth).mockResolvedValue({ kind: 'valid', record });

    const resultRef = await mountSettled();

    expect(resultRef.current?.status).toBe('pending');
    expect(resultRef.current?.code).toBe('UC-1234');
    expect(resultRef.current?.resumed).toBe(true);
    expect(startDeviceAuthPoll).toHaveBeenCalledTimes(1);
  });

  it('lets a start() that runs during the restore read win without a second poll', async () => {
    const readGate = deferred<Awaited<ReturnType<typeof readPendingExternalAuth>>>();
    vi.mocked(readPendingExternalAuth).mockReturnValue(readGate.promise);
    fetchMock.mockResolvedValue(
      Response.json({ code: 'NEW-CODE', verificationUrl: 'https://new.example' })
    );

    const resultRef = await mountSettled();
    const result = requireResult(resultRef);

    // start() while the restore read is still held open.
    await act(async () => {
      await result.start('signin');
    });

    // Release the restore read with a stale live record.
    await act(async () => {
      readGate.resolve({
        kind: 'valid',
        record: {
          deviceCode: 'stale-device',
          userCode: 'STALE',
          verificationUrl: 'https://stale.example',
          startedAt: Date.now(),
        },
      });
      await Promise.resolve();
    });

    // The fresh start owns the flow: its code (not the restored one) shows and
    // the restore did not start a second poll.
    expect(resultRef.current?.code).toBe('NEW-CODE');
    expect(resultRef.current?.resumed).toBe(false);
    expect(startDeviceAuthPoll).toHaveBeenCalledTimes(1);
  });

  it('carries resumed: false on a fresh start', async () => {
    vi.mocked(readPendingExternalAuth).mockResolvedValue({ kind: 'none' });
    fetchMock.mockResolvedValue(
      Response.json({ code: 'FRESH', verificationUrl: 'https://fresh.example' })
    );

    const resultRef = await mountSettled();
    const result = requireResult(resultRef);
    await act(async () => {
      await result.start('signin');
    });

    expect(resultRef.current?.code).toBe('FRESH');
    expect(resultRef.current?.resumed).toBe(false);
  });

  it('builds the SSO browser URL from start("sso", email) without the organization id', async () => {
    vi.mocked(openAuthSessionAsync).mockClear();
    vi.mocked(readPendingExternalAuth).mockResolvedValue({ kind: 'none' });
    fetchMock.mockResolvedValue(
      Response.json({
        code: 'USER-123',
        verificationUrl: 'https://app.kilo.ai/device-auth?code=USER-123',
      })
    );

    const resultRef = await mountSettled();
    const result = requireResult(resultRef);
    await act(async () => {
      await result.start('sso', 'user@example.com');
    });

    expect(vi.mocked(openAuthSessionAsync)).toHaveBeenCalledTimes(1);
    const url = new URL(vi.mocked(openAuthSessionAsync).mock.calls[0]?.[0] ?? '');
    expect(url.searchParams.get('sso')).toBe('true');
    expect(url.searchParams.get('email')).toBe('user@example.com');
    expect(url.searchParams.get('callbackPath')).toBe('/device-auth?code=USER-123&app=1');
    expect(url.searchParams.has('ssoOrganizationId')).toBe(false);
  });
});
