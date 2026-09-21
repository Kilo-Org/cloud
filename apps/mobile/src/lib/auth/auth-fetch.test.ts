import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTH_REQUEST_TIMEOUT_MS, postAuth } from '@/lib/auth/auth-fetch';

// Mock @/lib/config to avoid pulling in react-native at module import time.
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'http://localhost:3000',
}));

// The admission module imports expo-secure-store, expo-crypto, and
// @expo/app-integrity, which need a device runtime. Stub the single export
// postAuth uses.
vi.mock('@/lib/auth/admission', () => ({
  clearAttestKeyOnRefusal: vi.fn(),
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.4',
}));

describe('postAuth', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('forwards ssoOrganizationId on a non-ok SSO_ERROR response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ error: 'SSO_ERROR', ssoOrganizationId: 'org_1' }, { status: 400 })
    );

    const result = await postAuth('/api/auth/native/token', { provider: 'email' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'SSO_ERROR',
      ssoOrganizationId: 'org_1',
    });
  });

  it('resolves ssoOrganizationId undefined when the field is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ error: 'BLOCKED' }, { status: 400 })
    );

    const result = await postAuth('/api/auth/native/token', { provider: 'email' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'BLOCKED',
      ssoOrganizationId: undefined,
    });
  });

  it('aborts a hung POST at AUTH_REQUEST_TIMEOUT_MS and names it TIMEOUT', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const signal = init?.signal ?? undefined;
      if (signal) {
        signals.push(signal);
      }
      await new Promise<void>(resolve => {
        signal?.addEventListener('abort', () => {
          resolve();
        });
      });
      throw new Error('aborted');
    });

    const promise = postAuth('/api/auth/native/otp', { email: 'user@example.com' });
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS);
    const result = await promise;

    expect(result).toEqual({
      ok: false,
      errorCode: 'TIMEOUT',
      ssoOrganizationId: undefined,
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('names TIMEOUT when the abort lands after the headers arrive but the body stalls', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const signal = await Promise.resolve(init?.signal ?? undefined);
      const response = new Response(null);
      vi.spyOn(response, 'json').mockReturnValue(
        new Promise<never>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        })
      );
      return response;
    });

    const promise = postAuth('/api/auth/native/otp', { email: 'user@example.com' });
    await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS);
    const result = await promise;

    expect(result).toEqual({
      ok: false,
      errorCode: 'TIMEOUT',
      ssoOrganizationId: undefined,
    });
  });

  it('leaves a genuine network failure unnamed', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Network request failed'));

    const result = await postAuth('/api/auth/native/otp', { email: 'user@example.com' });

    expect(result).toEqual({
      ok: false,
      errorCode: undefined,
      ssoOrganizationId: undefined,
    });
  });
});
