import { describe, expect, it, vi } from 'vitest';
import { deriveCallbackToken, verifyCallbackToken } from './callback-token.js';
import { resetInternalAuthObservation } from './internal-auth-observation.js';

const SECRET = 'test-callback-token-secret';
const BASE_PARAMS = {
  secret: SECRET,
  scope: 'security-analysis-callback',
  resourceParts: ['finding-1'],
} as const;

describe('callback tokens', () => {
  it('derives the same token for the same scope and resource parts', async () => {
    const first = await deriveCallbackToken(BASE_PARAMS);
    const second = await deriveCallbackToken(BASE_PARAMS);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
  });

  it('changes when callback scope or bound resource changes', async () => {
    const token = await deriveCallbackToken(BASE_PARAMS);
    const changedScope = await deriveCallbackToken({
      ...BASE_PARAMS,
      scope: 'code-review-status-callback',
    });
    const changedResource = await deriveCallbackToken({
      ...BASE_PARAMS,
      resourceParts: ['finding-2'],
    });

    expect(changedScope).not.toBe(token);
    expect(changedResource).not.toBe(token);
  });

  it('keeps multi-part bindings unambiguous', async () => {
    const left = await deriveCallbackToken({
      secret: SECRET,
      scope: 'webhook-execution-callback',
      resourceParts: ['user/acme:trigger', 'request-1'],
    });
    const right = await deriveCallbackToken({
      secret: SECRET,
      scope: 'webhook-execution-callback',
      resourceParts: ['user/acme', 'trigger:request-1'],
    });

    expect(left).not.toBe(right);
  });

  it('accepts a valid token', async () => {
    const token = await deriveCallbackToken(BASE_PARAMS);

    await expect(verifyCallbackToken({ ...BASE_PARAMS, token })).resolves.toBe(true);
  });

  it.each([undefined, null, '', '   '])(
    'rejects missing or blank signing secret %j before importing HMAC key',
    async secret => {
      await expect(deriveCallbackToken({ ...BASE_PARAMS, secret })).rejects.toThrow(
        'Callback token secret must be configured and non-empty'
      );
    }
  );

  it.each([undefined, null, '', '   '])(
    'fails closed when verifying with missing or blank secret %j',
    async secret => {
      const token = await deriveCallbackToken(BASE_PARAMS);

      await expect(verifyCallbackToken({ ...BASE_PARAMS, secret, token })).resolves.toBe(false);
    }
  );

  it('does not report an acceptance unless observation is configured', async () => {
    const token = await deriveCallbackToken(BASE_PARAMS);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await verifyCallbackToken({ ...BASE_PARAMS, token });
    expect(log).not.toHaveBeenCalled();
    log.mockRestore();
    resetInternalAuthObservation();
  });

  it('reports an accepted callback token with its scope as the route label', async () => {
    const token = await deriveCallbackToken(BASE_PARAMS);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await expect(
      verifyCallbackToken({
        ...BASE_PARAMS,
        token,
        observation: { receiver: 'web', caller: 'security-auto-analysis' },
      })
    ).resolves.toBe(true);
    await expect(
      verifyCallbackToken({
        ...BASE_PARAMS,
        token: 'not-hex',
        observation: { receiver: 'web', caller: 'security-auto-analysis' },
      })
    ).resolves.toBe(false);

    expect(
      log.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>)
    ).toEqual([
      expect.objectContaining({
        event: 'kilo_internal_auth',
        receiver: 'web',
        route: BASE_PARAMS.scope,
        auth: 'legacy_shared_secret',
        caller: 'security-auto-analysis',
        count: 1,
      }),
    ]);
    log.mockRestore();
    resetInternalAuthObservation();
  });

  it.each([undefined, null, '', 'not-hex', 'a'.repeat(63), 'b'.repeat(64)])(
    'rejects absent, malformed, truncated, or wrong token %s',
    async token => {
      await expect(verifyCallbackToken({ ...BASE_PARAMS, token })).resolves.toBe(false);
    }
  );
});
