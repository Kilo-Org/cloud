// Do not import `jest` from '@jest/globals': the SWC transform hoists these `jest.mock` calls only
// with the global `jest`.
jest.mock('@kilocode/web-shared/lib/config.server', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/config.server'),
  // Read at each call, so a test sets the switch through `mockSenderAuth`.
  get SECURE_PROXY_SENDER_AUTH() {
    return mockSenderAuth.value;
  },
}));
jest.mock('@kilocode/web-shared/lib/sts-service-tokens', () => ({
  ...jest.requireActual<object>('@kilocode/web-shared/lib/sts-service-tokens'),
  stsServiceTokenIfHeld: jest.fn(),
}));

import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { ServiceTokenError } from '@kilocode/service-token-client';
import { STS_SECURE_PROXY_FORWARD } from '@kilocode/sts-contracts';
import { stsServiceTokenIfHeld } from '@kilocode/web-shared/lib/sts-service-tokens';
import { secureProxyCredential, secureProxySenderAuth } from './secure-proxy-sender';

const mockSenderAuth: { value: string | undefined } = { value: undefined };
const heldToken = jest.mocked(stsServiceTokenIfHeld);
const PRODUCTION = {
  VERCEL_ENV: 'production',
  VERCEL_TARGET_ENV: 'production',
  KILO_STS_WORKLOAD: 'ai-gateway',
} as const;

/** The proxy secret getter; `sts` must never call it. */
function proxySecret() {
  return jest.fn(() => 'proxy-secret');
}

beforeEach(() => {
  mockSenderAuth.value = undefined;
  heldToken.mockReset();
});

afterEach(() => {
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
    await expect(secureProxyCredential({ legacySecret })).resolves.toEqual({
      kind: 'ready',
      mode: 'legacy',
      authorization: 'Bearer proxy-secret',
    });
    expect(heldToken).not.toHaveBeenCalled();
  });

  it.each([undefined, '', 'legacy'])('keeps the legacy secret for %p', async auth => {
    const legacySecret = proxySecret();
    await expect(secureProxyCredential({ legacySecret, auth })).resolves.toMatchObject({
      mode: 'legacy',
      authorization: 'Bearer proxy-secret',
    });
    expect(heldToken).not.toHaveBeenCalled();
  });

  it('sends only a held STS token from the deployment STS environment', async () => {
    const legacySecret = proxySecret();
    heldToken.mockResolvedValue({ kind: 'token', token: 'sts-token' });
    await expect(
      secureProxyCredential({ legacySecret, auth: 'sts', runtime: PRODUCTION })
    ).resolves.toEqual({ kind: 'ready', mode: 'sts', authorization: 'Bearer sts-token' });
    expect(heldToken).toHaveBeenCalledWith('production', STS_SECURE_PROXY_FORWARD);
    expect(legacySecret).not.toHaveBeenCalled();
  });

  it('mints from the staging STS for the staging custom environment', async () => {
    heldToken.mockResolvedValue({ kind: 'token', token: 'sts-token' });
    await secureProxyCredential({
      legacySecret: proxySecret(),
      auth: 'sts',
      runtime: {
        VERCEL_ENV: 'preview',
        VERCEL_TARGET_ENV: 'staging',
        KILO_STS_WORKLOAD: 'ai-gateway',
      },
    });
    expect(heldToken).toHaveBeenCalledWith('staging', STS_SECURE_PROXY_FORWARD);
  });

  it('sends nothing under sts outside the ai-gateway build', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const legacySecret = proxySecret();
    await expect(
      secureProxyCredential({
        legacySecret,
        auth: 'sts',
        runtime: { ...PRODUCTION, KILO_STS_WORKLOAD: undefined },
      })
    ).resolves.toEqual({ kind: 'unavailable', reason: 'not_ai_gateway' });
    expect(heldToken).not.toHaveBeenCalled();
    expect(legacySecret).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      '[secure-proxy-sender] no credential for the secure proxy forward',
      { reason: 'not_ai_gateway' }
    );
  });

  it('sends nothing under sts on a deployment without an STS environment', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    await expect(
      secureProxyCredential({
        legacySecret: proxySecret(),
        auth: 'sts',
        runtime: {
          VERCEL_ENV: 'production',
          VERCEL_TARGET_ENV: 'staging',
          KILO_STS_WORKLOAD: 'ai-gateway',
        },
      })
    ).resolves.toEqual({ kind: 'unavailable', reason: 'no_sts_environment' });
    expect(heldToken).not.toHaveBeenCalled();
  });

  it('refuses the forward while no token is held, never reading the secret', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const legacySecret = proxySecret();
    heldToken.mockResolvedValue({ kind: 'not_held' });
    await expect(
      secureProxyCredential({ legacySecret, auth: 'sts', runtime: PRODUCTION })
    ).resolves.toEqual({ kind: 'unavailable', reason: 'credential_not_held' });
    expect(legacySecret).not.toHaveBeenCalled();
  });

  it('names a denied token apart from an unavailable one', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    heldToken.mockResolvedValue({
      kind: 'failed',
      error: new ServiceTokenError(
        { reason: 'denied', deniedReason: 'scope_not_allowed' },
        STS_SECURE_PROXY_FORWARD
      ),
    });
    await expect(
      secureProxyCredential({ legacySecret: proxySecret(), auth: 'sts', runtime: PRODUCTION })
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

  it('answers token_unavailable when the read gave no token in time', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    heldToken.mockResolvedValue({
      kind: 'failed',
      error: new ServiceTokenError(
        { reason: 'unavailable', retryAfterSeconds: 30 },
        STS_SECURE_PROXY_FORWARD
      ),
    });
    await expect(
      secureProxyCredential({ legacySecret: proxySecret(), auth: 'sts', runtime: PRODUCTION })
    ).resolves.toEqual({ kind: 'unavailable', reason: 'token_unavailable' });
  });

  it('never reads the old secret for a value outside the closed set', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const legacySecret = proxySecret();
    await expect(secureProxyCredential({ legacySecret, auth: 'dual' })).resolves.toEqual({
      kind: 'unavailable',
      reason: 'auth_misconfigured',
    });
    expect(legacySecret).not.toHaveBeenCalled();
    expect(heldToken).not.toHaveBeenCalled();
  });
});
