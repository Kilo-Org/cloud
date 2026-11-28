// Do not import `jest` from '@jest/globals': the SWC transform hoists these `jest.mock` calls only
// with the global `jest`.
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  // Read at each call, so a test sets both through `mockConfig`.
  get SECURE_PROXY_SENDER_AUTH() {
    return mockConfig.auth;
  },
  get SECURE_PROXY_EXPECTED_ORIGIN() {
    return mockConfig.expectedOrigin;
  },
}));
jest.mock('@kilocode/web-shared/lib/sts-service-tokens', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/sts-service-tokens'),
  stsServiceToken: jest.fn(),
}));
jest.mock('@vercel/functions', () => ({
  ...jest.requireActual<object>('@vercel/functions'),
  waitUntil: jest.fn(),
}));

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ServiceTokenError } from '@kilocode/service-token-client';
import { STS_SECURE_PROXY_FORWARD } from '@kilocode/sts-contracts';
import { waitUntil } from '@vercel/functions';
import { stsServiceToken } from '@kilocode/web-shared/lib/sts-service-tokens';
import { secureProxyCredential, secureProxySenderAuth } from './secure-proxy-sender';
import { SECURE_PROXY_COLD_TOKEN_WAIT_MS } from './secure-proxy-sts';

const mockConfig: { auth: string | undefined; expectedOrigin: string | undefined } = {
  auth: undefined,
  expectedOrigin: undefined,
};
const mintedToken = jest.mocked(stsServiceToken);
const keptAlive = jest.mocked(waitUntil);
const PROXY_URL = 'https://secure-proxy.example.com/api/proxy';
const PROXY_ORIGIN = 'https://secure-proxy.example.com';
const PRODUCTION = { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'production' } as const;

/** The proxy secret getter; `sts` must never call it. */
function proxySecret() {
  return jest.fn(() => 'proxy-secret');
}

beforeEach(() => {
  mockConfig.auth = undefined;
  mockConfig.expectedOrigin = PROXY_ORIGIN;
  mintedToken.mockReset();
  keptAlive.mockReset();
  // As `apps/ai-gateway/next.config.mjs` inlines it; a `kilocode-app` test deletes it.
  process.env.KILO_STS_WORKLOAD = 'ai-gateway';
});

afterEach(() => {
  delete process.env.KILO_STS_WORKLOAD;
  jest.useRealTimers();
  jest.restoreAllMocks();
});

describe('secureProxySenderAuth', () => {
  it.each([
    [undefined, 'legacy'],
    ['', 'legacy'],
    ['legacy', 'legacy'],
    ['sts', 'sts'],
    ['STS', null],
    ['dual', null],
    [' sts', null],
  ])('reads %p as %p', (value, mode) => {
    expect(secureProxySenderAuth(value)).toBe(mode);
  });
});

describe('secureProxyCredential', () => {
  it('sends the stored proxy secret while the switch is unset, without asking STS', async () => {
    const legacySecret = proxySecret();
    mockConfig.expectedOrigin = undefined;
    await expect(secureProxyCredential({ legacySecret, proxyUrl: PROXY_URL })).resolves.toEqual({
      kind: 'ready',
      mode: 'legacy',
      authorization: 'Bearer proxy-secret',
    });
    expect(mintedToken).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'legacy'])('keeps the legacy secret for %p', async auth => {
    const legacySecret = proxySecret();
    await expect(
      secureProxyCredential({ legacySecret, proxyUrl: PROXY_URL, auth })
    ).resolves.toMatchObject({
      mode: 'legacy',
      authorization: 'Bearer proxy-secret',
    });
    expect(mintedToken).not.toHaveBeenCalled();
  });

  it('sends only a held STS token from the deployment STS environment', async () => {
    const legacySecret = proxySecret();
    mintedToken.mockResolvedValue('sts-token');
    await expect(
      secureProxyCredential({ legacySecret, proxyUrl: PROXY_URL, auth: 'sts', runtime: PRODUCTION })
    ).resolves.toEqual({ kind: 'ready', mode: 'sts', authorization: 'Bearer sts-token' });
    expect(mintedToken).toHaveBeenCalledWith('production', STS_SECURE_PROXY_FORWARD);
    expect(legacySecret).not.toHaveBeenCalled();
  });

  it('mints from the staging STS for the staging custom environment', async () => {
    mintedToken.mockResolvedValue('sts-token');
    await secureProxyCredential({
      legacySecret: proxySecret(),
      proxyUrl: PROXY_URL,
      auth: 'sts',
      runtime: { VERCEL_ENV: 'preview', VERCEL_TARGET_ENV: 'staging' },
    });
    expect(mintedToken).toHaveBeenCalledWith('staging', STS_SECURE_PROXY_FORWARD);
  });

  it('lets a cold instance read the token its mint answers in 100 ms', async () => {
    mintedToken.mockImplementation(() => {
      const { promise, resolve } = Promise.withResolvers<string>();
      setTimeout(() => resolve('sts-token'), 100);
      return promise;
    });
    jest.useFakeTimers();
    const pending = secureProxyCredential({
      legacySecret: proxySecret(),
      proxyUrl: PROXY_URL,
      auth: 'sts',
      runtime: PRODUCTION,
    });
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(100);
    await expect(pending).resolves.toEqual({
      kind: 'ready',
      mode: 'sts',
      authorization: 'Bearer sts-token',
    });
  });

  it('waits exactly the 2000 ms bound for a cold mint, then refuses', async () => {
    expect(SECURE_PROXY_COLD_TOKEN_WAIT_MS).toBe(2000);
    const never = Promise.withResolvers<string>();
    mintedToken.mockReturnValue(never.promise);
    const legacySecret = proxySecret();
    jest.useFakeTimers();
    const pending = secureProxyCredential({
      legacySecret,
      proxyUrl: PROXY_URL,
      auth: 'sts',
      runtime: PRODUCTION,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(SECURE_PROXY_COLD_TOKEN_WAIT_MS - 1);
    expect(settled).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toEqual({ kind: 'unavailable', reason: 'credential_not_held' });
    expect(mintedToken).toHaveBeenCalledTimes(1);
    expect(legacySecret).not.toHaveBeenCalled();
  });

  it('keeps the in-flight mint alive when the cold wait times out', async () => {
    const mint = Promise.withResolvers<string>();
    mintedToken.mockReturnValue(mint.promise);
    jest.useFakeTimers();
    const pending = secureProxyCredential({
      legacySecret: proxySecret(),
      proxyUrl: PROXY_URL,
      auth: 'sts',
      runtime: PRODUCTION,
    });

    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(SECURE_PROXY_COLD_TOKEN_WAIT_MS);
    await expect(pending).resolves.toEqual({ kind: 'unavailable', reason: 'credential_not_held' });

    // The same attempt the client is running, not a second mint, handed to `waitUntil`: a frozen
    // instance still finishes it, and its answer is the token the retry reads.
    expect(mintedToken).toHaveBeenCalledTimes(1);
    expect(keptAlive).toHaveBeenCalledTimes(1);
    const kept = keptAlive.mock.calls[0][0];
    mint.resolve('sts-token');
    await expect(kept).resolves.toEqual({ kind: 'token', token: 'sts-token' });
  });

  it('ends the cold wait early when the client aborts', async () => {
    const mint = Promise.withResolvers<string>();
    mintedToken.mockReturnValue(mint.promise);
    const controller = new AbortController();
    jest.useFakeTimers();
    const pending = secureProxyCredential({
      legacySecret: proxySecret(),
      proxyUrl: PROXY_URL,
      auth: 'sts',
      runtime: PRODUCTION,
      signal: controller.signal,
    });
    let settled = false;
    void pending.then(() => {
      settled = true;
    });

    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(100);
    expect(settled).toBe(false);
    controller.abort();
    await expect(pending).resolves.toEqual({ kind: 'unavailable', reason: 'credential_not_held' });
    expect(keptAlive).toHaveBeenCalledTimes(1);
  });

  it('shares one cold mint between concurrent calls and keeps it alive for each', async () => {
    const mint = Promise.withResolvers<string>();
    mintedToken.mockReturnValue(mint.promise);
    jest.useFakeTimers();
    const first = secureProxyCredential({
      legacySecret: proxySecret(),
      proxyUrl: PROXY_URL,
      auth: 'sts',
      runtime: PRODUCTION,
    });
    const second = secureProxyCredential({
      legacySecret: proxySecret(),
      proxyUrl: PROXY_URL,
      auth: 'sts',
      runtime: PRODUCTION,
    });

    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(SECURE_PROXY_COLD_TOKEN_WAIT_MS);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { kind: 'unavailable', reason: 'credential_not_held' },
      { kind: 'unavailable', reason: 'credential_not_held' },
    ]);
    // One read per call of the client's single attempt, and no mint started by the timeout.
    expect(mintedToken).toHaveBeenCalledTimes(2);
    expect(keptAlive).toHaveBeenCalledTimes(2);
    mint.resolve('sts-token');
    await expect(Promise.all(keptAlive.mock.calls.map(([kept]) => kept))).resolves.toEqual([
      { kind: 'token', token: 'sts-token' },
      { kind: 'token', token: 'sts-token' },
    ]);
  });

  it.each([
    ['unset', undefined],
    ['invalid', 'https://secure-proxy.example.com/api/proxy'],
    ['foreign', 'https://other-proxy.example.com'],
  ])(
    'refuses an %s expected origin without minting or reading the secret',
    async (_name, origin) => {
      jest.spyOn(console, 'warn').mockImplementation(() => {});
      mockConfig.expectedOrigin = origin;
      const legacySecret = proxySecret();
      await expect(
        secureProxyCredential({
          legacySecret,
          proxyUrl: PROXY_URL,
          auth: 'sts',
          runtime: PRODUCTION,
        })
      ).resolves.toEqual({ kind: 'unavailable', reason: 'proxy_origin_mismatch' });
      expect(mintedToken).not.toHaveBeenCalled();
      expect(legacySecret).not.toHaveBeenCalled();
    }
  );

  it('refuses a proxy URL of another origin than the expected one', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      secureProxyCredential({
        legacySecret: proxySecret(),
        proxyUrl: 'https://attacker.example.com/api/proxy',
        auth: 'sts',
        runtime: PRODUCTION,
      })
    ).resolves.toEqual({ kind: 'unavailable', reason: 'proxy_origin_mismatch' });
    expect(mintedToken).not.toHaveBeenCalled();
  });

  it('sends nothing under sts outside the ai-gateway build', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const legacySecret = proxySecret();
    delete process.env.KILO_STS_WORKLOAD;
    const options = {
      legacySecret,
      proxyUrl: PROXY_URL,
      auth: 'sts',
      runtime: PRODUCTION,
    } as const;
    await expect(secureProxyCredential(options)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not_ai_gateway',
    });
    await expect(secureProxyCredential(options)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not_ai_gateway',
    });
    expect(mintedToken).not.toHaveBeenCalled();
    expect(legacySecret).not.toHaveBeenCalled();
    // One line per reason and process, never one per request.
    expect(warn.mock.calls).toEqual([
      [
        '[secure-proxy-sender] no credential for the secure proxy forward',
        { reason: 'not_ai_gateway' },
      ],
    ]);
  });

  it('sends nothing under sts on a deployment without an STS environment', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      secureProxyCredential({
        legacySecret: proxySecret(),
        proxyUrl: PROXY_URL,
        auth: 'sts',
        runtime: { VERCEL_ENV: 'production', VERCEL_TARGET_ENV: 'staging' },
      })
    ).resolves.toEqual({ kind: 'unavailable', reason: 'no_sts_environment' });
    expect(mintedToken).not.toHaveBeenCalled();
  });

  it('names a denied token apart from an unavailable one', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mintedToken.mockImplementation(() =>
      Promise.reject(
        new ServiceTokenError(
          { reason: 'denied', deniedReason: 'scope_not_allowed' },
          STS_SECURE_PROXY_FORWARD
        )
      )
    );
    await expect(
      secureProxyCredential({
        legacySecret: proxySecret(),
        proxyUrl: PROXY_URL,
        auth: 'sts',
        runtime: PRODUCTION,
      })
    ).resolves.toEqual({ kind: 'unavailable', reason: 'token_denied' });
    expect(warn).toHaveBeenCalledWith(
      '[secure-proxy-sender] no credential for the secure proxy forward',
      {
        reason: 'token_denied',
        failure: {
          errorName: 'ServiceTokenError',
          reason: 'denied',
          deniedReason: 'scope_not_allowed',
        },
      }
    );
  });

  it('answers token_unavailable when the mint gave no token in time', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    mintedToken.mockImplementation(() =>
      Promise.reject(
        new ServiceTokenError(
          { reason: 'unavailable', retryAfterSeconds: 30 },
          STS_SECURE_PROXY_FORWARD
        )
      )
    );
    await expect(
      secureProxyCredential({
        legacySecret: proxySecret(),
        proxyUrl: PROXY_URL,
        auth: 'sts',
        runtime: PRODUCTION,
      })
    ).resolves.toEqual({ kind: 'unavailable', reason: 'token_unavailable' });
  });

  it('never reads the old secret for a value outside the closed set', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const legacySecret = proxySecret();
    await expect(
      secureProxyCredential({ legacySecret, proxyUrl: PROXY_URL, auth: 'dual' })
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'auth_misconfigured',
    });
    expect(legacySecret).not.toHaveBeenCalled();
    expect(mintedToken).not.toHaveBeenCalled();
  });
});
