import { afterEach, describe, expect, it, vi } from 'vitest';

import { AUTH_REQUEST_TIMEOUT_MS, postAuth } from '@/lib/auth/auth-fetch';
import { clearAttestKeyOnRefusal } from '@/lib/auth/admission';
import { resetAuthTerminalReports } from '@/lib/auth/auth-response-class';
import { setTelemetrySink, type TelemetryEvent } from '@/lib/telemetry/error-sink';
import { createNetworkErrorFetch } from '@/lib/telemetry/network-errors';

// Mock @/lib/config to avoid pulling in react-native at module import time.
vi.mock('@/lib/config', () => ({
  API_BASE_URL: 'http://localhost:3000',
}));

// The admission module imports expo-secure-store, expo-crypto, and
// @expo/app-integrity, which need a device runtime. Stub the two exports
// postAuth uses: the refusal clear, and the proof rebuilt for the one
// unknown-key retry.
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

describe('postAuth', () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetAuthTerminalReports();
  });

  it('sends the app product token as the User-Agent so device sessions record it', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(Response.json({ token: 't', refreshToken: 'r' }));

    await postAuth('/api/auth/native/token', { provider: 'email' });

    expect(fetchSpy.mock.calls[0]?.[1]?.headers).toMatchObject({
      'User-Agent': 'Kilo-Code/1.0.4 (ios)',
    });
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
      httpStatus: 400,
      terminal: true,
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
      httpStatus: 400,
      terminal: true,
    });
  });

  it('classifies a 401 on a credential route as terminal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json({ error: 'INVALID_CODE' }, { status: 401 })
    );

    const result = await postAuth('/api/auth/native/token', { provider: 'email' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'INVALID_CODE',
      ssoOrganizationId: undefined,
      httpStatus: 401,
      terminal: true,
    });
  });

  it('keeps a 429 retryable and carries the server Retry-After', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      Response.json(
        { error: 'TOO_MANY_ATTEMPTS' },
        { status: 429, headers: { 'retry-after': '7' } }
      )
    );

    const result = await postAuth('/api/auth/native/otp', { email: 'user@example.com' });

    expect(result).toEqual({
      ok: false,
      errorCode: 'TOO_MANY_ATTEMPTS',
      ssoOrganizationId: undefined,
      httpStatus: 429,
      terminal: false,
      retryAfterMs: 7000,
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
      terminal: false,
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
      terminal: false,
    });
  });

  it('leaves a genuine network failure unnamed', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Network request failed'));

    const result = await postAuth('/api/auth/native/otp', { email: 'user@example.com' });

    expect(result).toEqual({
      ok: false,
      errorCode: undefined,
      ssoOrganizationId: undefined,
      terminal: false,
    });
  });

  describe('App Attest token POST transport diagnostic', () => {
    const appleProofBody = {
      provider: 'email',
      admission: {
        platform: 'ios',
        kind: 'assertion',
        challenge: 'server-challenge',
        payload: 'assertion-b64',
        keyId: 'key-1',
      },
    };

    /** The events filed through the installed sink during one call. */
    async function eventsDuring(run: () => Promise<unknown>): Promise<TelemetryEvent[]> {
      const events: TelemetryEvent[] = [];
      setTelemetrySink(event => {
        events.push(event);
      });
      try {
        await run();
      } finally {
        setTelemetrySink(null);
      }
      return events;
    }

    it('files the timeout step when an Apple-proof token POST hits the deadline', async () => {
      vi.useFakeTimers();
      vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
        const stalled = Promise.withResolvers<unknown>();
        init?.signal?.addEventListener('abort', () => {
          stalled.resolve(undefined);
        });
        await stalled.promise;
        throw new Error('aborted');
      });

      const events = await eventsDuring(async () => {
        const promise = postAuth('/api/auth/native/token', appleProofBody);
        await vi.advanceTimersByTimeAsync(AUTH_REQUEST_TIMEOUT_MS);
        await promise;
      });

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        level: 'error',
        message: 'App Attest failure',
        tags: {
          'app_attest.step': 'post',
          'app_attest.error_domain': 'js_transport',
          'app_attest.error_code': 'timeout',
        },
      });
    });

    it('files the network step when an Apple-proof token POST is rejected', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('Network request failed'));

      const events = await eventsDuring(() => postAuth('/api/auth/native/token', appleProofBody));

      expect(events.map(event => event.tags)).toEqual([
        {
          'app_attest.step': 'post',
          'app_attest.error_domain': 'js_transport',
          'app_attest.error_code': 'network',
        },
      ]);
      // The payload the POST carried never reaches the event.
      const text = JSON.stringify(events);
      expect(text).not.toContain('assertion-b64');
      expect(text).not.toContain('server-challenge');
      expect(text).not.toContain('key-1');
    });

    it('keeps an Android proof out of the App Attest diagnostic', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('offline'));

      const events = await eventsDuring(() =>
        postAuth('/api/auth/native/token', {
          provider: 'email',
          admission: { platform: 'android', kind: 'assertion' },
        })
      );

      expect(events).toEqual([]);
    });

    it('keeps a proof-less token POST out of the App Attest diagnostic', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('offline'));

      const events = await eventsDuring(() =>
        postAuth('/api/auth/native/token', { provider: 'email' })
      );

      expect(events).toEqual([]);
    });

    it('does not report a server refusal as a transport failure', async () => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        Response.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 })
      );

      const events = await eventsDuring(() => postAuth('/api/auth/native/token', appleProofBody));

      expect(events.map(event => event.fingerprint)).toEqual([
        ['auth-terminal', '/api/auth/native/token', '403'],
      ]);
    });

    it('does not report local keychain cleanup as a transport failure', async () => {
      // A keychain failure while clearing the refused key id is a local fault,
      // not the POST's transport: it must never become a `post` diagnostic.
      vi.mocked(clearAttestKeyOnRefusal).mockRejectedValueOnce(new Error('keychain unavailable'));
      vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
        Response.json({ error: 'ADMISSION_REQUIRED' }, { status: 403 })
      );

      const events = await eventsDuring(() => postAuth('/api/auth/native/token', appleProofBody));

      // The keychain rejection leaves the POST's `catch` and keeps its generic
      // failure; only the report above is wrong, and there is none.
      expect(events).toEqual([]);
    });

    it('does not report a non-token route carrying an iOS admission shape', async () => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new TypeError('offline'));

      const events = await eventsDuring(() => postAuth('/api/auth/native/otp', appleProofBody));

      expect(events).toEqual([]);
    });
  });

  // KILO-APP-2N2 duplicated KILO-APP-2VV: the global fetch wrapper filed the
  // same terminal refusal the auth layer already reports. One event remains.
  it.each([400, 403])(
    'reports a terminal %i once, through the auth layer, behind the fetch wrapper',
    async status => {
      const events: TelemetryEvent[] = [];
      setTelemetrySink(event => {
        events.push(event);
      });
      const baseFetch = vi.fn();
      baseFetch.mockResolvedValue(Response.json({ error: 'BLOCKED' }, { status }));
      vi.stubGlobal('fetch', createNetworkErrorFetch(baseFetch as unknown as typeof fetch));
      try {
        await postAuth('/api/auth/native/token', { provider: 'email' });
      } finally {
        vi.unstubAllGlobals();
        setTelemetrySink(null);
      }

      expect(events.map(event => event.fingerprint)).toEqual([
        ['auth-terminal', '/api/auth/native/token', String(status)],
      ]);
    }
  );
});
