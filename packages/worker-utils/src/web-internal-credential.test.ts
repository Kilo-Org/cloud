import type { MintBinding } from '@kilocode/service-token-client';
import type { MintRequest, MintResult } from '@kilocode/sts-contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  STS_WEB_SCIM_SYNC,
  STS_WEB_USER_DATA_EXPORT_READY,
  webInternalAuthMode,
  webInternalCredential,
} from './web-internal-credential';

function issuing(): MintBinding & { requests: MintRequest[] } {
  const requests: MintRequest[] = [];
  return {
    requests,
    async mintTokens(request: MintRequest): Promise<MintResult> {
      requests.push(request);
      const expiresAt = Math.floor(Date.now() / 1000) + 300;
      return {
        status: 'ok',
        tokens: request.tokens.map(({ audience, scope }) => ({
          status: 'issued',
          audience,
          scope,
          token: `token-for-${scope}`,
          jti: `jti-${scope}`,
          expiresAt,
        })),
      };
    },
  };
}

function answering(result: MintResult): MintBinding {
  return { mintTokens: async () => result };
}

const legacySecret = (value: string | null) => ({
  header: 'x-internal-api-key',
  secret: vi.fn(async () => value),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('webInternalAuthMode', () => {
  it('defaults to legacy and accepts sts once switched on', () => {
    expect(webInternalAuthMode(undefined)).toBe('legacy');
    expect(webInternalAuthMode('')).toBe('legacy');
    expect(webInternalAuthMode('legacy')).toBe('legacy');
    expect(webInternalAuthMode('sts')).toBe('sts');
  });

  it('refuses every other value', () => {
    expect(webInternalAuthMode('STS')).toBeNull();
    expect(webInternalAuthMode('secrets-store')).toBeNull();
    expect(webInternalAuthMode('dual')).toBeNull();
  });
});

describe('webInternalCredential', () => {
  it('sends an STS bearer for the route scope under sts, never reading the secret', async () => {
    const binding = issuing();
    const legacy = legacySecret('shared-secret');

    const credential = await webInternalCredential(
      { WEB_INTERNAL_AUTH: 'sts', STS: binding },
      STS_WEB_SCIM_SYNC,
      legacy
    );

    expect(credential).toEqual({
      kind: 'ready',
      header: 'authorization',
      value: 'Bearer token-for-web:scim.sync',
    });
    expect(binding.requests).toEqual([{ tokens: [STS_WEB_SCIM_SYNC] }]);
    expect(legacy.secret).not.toHaveBeenCalled();
  });

  it('serves a held token from memory on the next request', async () => {
    const binding = issuing();
    const legacy = legacySecret('shared-secret');
    const env = { WEB_INTERNAL_AUTH: 'sts', STS: binding };

    await webInternalCredential(env, STS_WEB_USER_DATA_EXPORT_READY, legacy);
    await webInternalCredential(env, STS_WEB_USER_DATA_EXPORT_READY, legacy);

    expect(binding.requests).toHaveLength(1);
  });

  it('sends the legacy header, and no STS call, when the switch is absent', async () => {
    const binding = issuing();
    const legacy = legacySecret('shared-secret');

    const credential = await webInternalCredential({ STS: binding }, STS_WEB_SCIM_SYNC, legacy);

    expect(credential).toEqual({
      kind: 'ready',
      header: 'x-internal-api-key',
      value: 'shared-secret',
    });
    expect(binding.requests).toHaveLength(0);
  });

  it('sends the legacy header, and no STS call, when switched back to legacy', async () => {
    const binding = issuing();
    const legacy = legacySecret('shared-secret');

    const credential = await webInternalCredential(
      { WEB_INTERNAL_AUTH: 'legacy', STS: binding },
      STS_WEB_SCIM_SYNC,
      legacy
    );

    expect(credential).toEqual({
      kind: 'ready',
      header: 'x-internal-api-key',
      value: 'shared-secret',
    });
    expect(binding.requests).toHaveLength(0);
  });

  it('formats the legacy value when the route expects a bearer secret', async () => {
    const credential = await webInternalCredential(
      { WEB_INTERNAL_AUTH: 'legacy' },
      STS_WEB_SCIM_SYNC,
      { header: 'authorization', secret: async () => 'shared', format: s => `Bearer ${s}` }
    );

    expect(credential).toEqual({ kind: 'ready', header: 'authorization', value: 'Bearer shared' });
  });

  it('sends nothing for an unknown mode, without reading either credential', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const binding = issuing();
    const legacy = legacySecret('shared-secret');

    const credential = await webInternalCredential(
      { WEB_INTERNAL_AUTH: 'dual', STS: binding },
      STS_WEB_SCIM_SYNC,
      legacy
    );

    expect(credential).toEqual({ kind: 'unavailable', reason: 'auth_misconfigured' });
    expect(binding.requests).toHaveLength(0);
    expect(legacy.secret).not.toHaveBeenCalled();
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toEqual({
      event: 'web_internal_credential_unavailable',
      audience: 'web',
      scope: 'web:scim.sync',
      reason: 'auth_misconfigured',
    });
  });

  it('refuses sts mode on a Worker without the STS binding, never falling back to the secret', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const legacy = legacySecret('shared-secret');

    const credential = await webInternalCredential(
      { WEB_INTERNAL_AUTH: 'sts' },
      STS_WEB_SCIM_SYNC,
      legacy
    );

    expect(credential).toEqual({ kind: 'unavailable', reason: 'sts_binding_missing' });
    expect(legacy.secret).not.toHaveBeenCalled();
  });

  it('reports a denial with its reason and no token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scope = { audience: 'web', scope: 'web:denied-test' };

    const credential = await webInternalCredential(
      {
        WEB_INTERNAL_AUTH: 'sts',
        STS: answering({
          status: 'ok',
          tokens: [
            { status: 'denied', audience: 'web', scope: scope.scope, reason: 'unknown_scope' },
          ],
        }),
      },
      scope,
      legacySecret('shared-secret')
    );

    expect(credential).toEqual({ kind: 'unavailable', reason: 'token_denied' });
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      reason: 'token_denied',
      denied_reason: 'unknown_scope',
    });
  });

  it('reports an STS outage as unavailable with its retry hint', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const scope = { audience: 'web', scope: 'web:outage-test' };

    const credential = await webInternalCredential(
      { WEB_INTERNAL_AUTH: 'sts', STS: answering({ status: 'unavailable', retryAfterSeconds: 7 }) },
      scope,
      legacySecret('shared-secret')
    );

    expect(credential).toEqual({ kind: 'unavailable', reason: 'token_unavailable' });
    const line = JSON.parse(String(warn.mock.calls[0]?.[0]));
    expect(line.reason).toBe('token_unavailable');
    expect(line.retry_after_seconds).toBeGreaterThanOrEqual(7);
  });

  it('refuses an empty legacy secret', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const credential = await webInternalCredential({}, STS_WEB_SCIM_SYNC, legacySecret(''));

    expect(credential).toEqual({ kind: 'unavailable', reason: 'secret_missing' });
  });
});
