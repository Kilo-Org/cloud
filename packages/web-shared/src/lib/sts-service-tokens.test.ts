import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { STS_ISSUERS, STS_O11Y_API_METRICS_WRITE } from '@kilocode/sts-contracts';

// `stsServiceTokenIfHeld` over the real `createHttpServiceTokens` client: only the network (the STS
// mint call) and the Vercel identity are faked. A held token must come back as a token, never as
// `not_held`: the client answers it within microtasks (see `HELD_TOKEN_MARGIN_SECONDS`).

const mockWaitUntil = jest.fn<void, [Promise<unknown>]>();
jest.mock('@vercel/functions', () => ({
  getCache: jest.fn(() => ({})),
  waitUntil: (promise: Promise<unknown>) => mockWaitUntil(promise),
}));

const IDENTITY = 'exchanged-identity-token';
jest.mock('@kilocode/service-token-client/vercel', () => ({
  vercelIdentity: jest.fn(() => async () => 'exchanged-identity-token'),
}));

const MINT_URL = `${STS_ISSUERS.production}/v1/token`;
const TOKEN_LIFETIME_SECONDS = 300;
const originalFetch = globalThis.fetch;
const mockFetch = jest.fn<Promise<Response>, Parameters<typeof fetch>>();
let minted = 0;

function issued(): Response {
  minted += 1;
  return Response.json({
    status: 'ok',
    tokens: [
      {
        status: 'issued',
        audience: STS_O11Y_API_METRICS_WRITE.audience,
        scope: STS_O11Y_API_METRICS_WRITE.scope,
        token: `held-token-${minted}`,
        jti: `jti-${minted}`,
        expiresAt: Math.floor(Date.now() / 1000) + TOKEN_LIFETIME_SECONDS,
      },
    ],
  });
}

/** A fresh module: it keeps one token client per process. */
async function freshModule() {
  jest.resetModules();
  return await import('./sts-service-tokens');
}

/** Settles everything handed to `waitUntil` so far, the background read and its mint included. */
async function settleBackground(): Promise<void> {
  await Promise.all(mockWaitUntil.mock.calls.map(([promise]) => promise.catch(() => {})));
}

beforeEach(() => {
  minted = 0;
  mockWaitUntil.mockReset();
  mockFetch.mockReset();
  mockFetch.mockImplementation(async () => issued());
  globalThis.fetch = mockFetch as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  jest.restoreAllMocks();
});

describe('stsServiceTokenIfHeld over the real token client', () => {
  test('a cold read answers not_held at once; once minted, a held token is returned', async () => {
    const { stsServiceTokenIfHeld } = await freshModule();
    await expect(stsServiceTokenIfHeld('production', STS_O11Y_API_METRICS_WRITE)).resolves.toEqual({
      kind: 'not_held',
    });

    await settleBackground();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockFetch.mock.calls[0] ?? [];
    expect(url).toBe(MINT_URL);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${IDENTITY}`);
    expect(JSON.parse(init?.body as string)).toEqual({
      tokens: [{ audience: 'o11y', scope: 'o11y:api-metrics.write' }],
    });

    for (let i = 0; i < 3; i++) {
      await expect(
        stsServiceTokenIfHeld('production', STS_O11Y_API_METRICS_WRITE)
      ).resolves.toEqual({ kind: 'token', token: 'held-token-1' });
    }
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  test('a held token past its renewal point is returned while the renewal runs on', async () => {
    const { stsServiceTokenIfHeld } = await freshModule();
    await stsServiceTokenIfHeld('production', STS_O11Y_API_METRICS_WRITE);
    await settleBackground();

    // 250 s into a 300 s token: past renewal (240 s), inside the usable window (270 s).
    const now = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 250_000);
    await expect(stsServiceTokenIfHeld('production', STS_O11Y_API_METRICS_WRITE)).resolves.toEqual({
      kind: 'token',
      token: 'held-token-1',
    });
    now.mockRestore();

    await settleBackground();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    await expect(stsServiceTokenIfHeld('production', STS_O11Y_API_METRICS_WRITE)).resolves.toEqual({
      kind: 'token',
      token: 'held-token-2',
    });
  });

  test('a refusal the client already holds is failed, not not_held', async () => {
    const { stsServiceTokenIfHeld } = await freshModule();
    const request = { audience: 'o11y', scope: 'o11y:alerting.read' };
    mockFetch.mockImplementation(async () =>
      Response.json({
        status: 'ok',
        tokens: [{ status: 'denied', ...request, reason: 'scope_not_allowed' }],
      })
    );
    await expect(stsServiceTokenIfHeld('production', request)).resolves.toEqual({
      kind: 'not_held',
    });
    await settleBackground();

    const refused = await stsServiceTokenIfHeld('production', request);
    expect(refused.kind).toBe('failed');
    expect(refused.kind === 'failed' ? refused.error : null).toMatchObject({
      name: 'ServiceTokenError',
      reason: 'denied',
      deniedReason: 'scope_not_allowed',
    });
  });
});
