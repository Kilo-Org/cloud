import { describe, expect, it } from 'vitest';
import { deriveCallbackToken, verifyCallbackToken } from './callback-token.js';

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

  it.each([undefined, null, '', 'not-hex', 'a'.repeat(63), 'b'.repeat(64)])(
    'rejects absent, malformed, truncated, or wrong token %s',
    async token => {
      await expect(verifyCallbackToken({ ...BASE_PARAMS, token })).resolves.toBe(false);
    }
  );
});
