import { describe, expect, it } from 'vitest';
import { deriveCallbackToken } from '@kilocode/worker-utils/callback-token';
import { buildAutoFixPrCallbackTarget } from './callback-target';

describe('buildAutoFixPrCallbackTarget', () => {
  it('binds ticket identity into callback URL and token header', async () => {
    const ticketId = 'ticket id/with?reserved=true';
    const callbackTokenSecret = 'test-callback-token-secret';
    const callbackTarget = await buildAutoFixPrCallbackTarget({
      apiUrl: 'https://api.test/base',
      ticketId,
      callbackTokenSecret,
    });
    const expectedToken = await deriveCallbackToken({
      secret: callbackTokenSecret,
      scope: 'auto-fix-pr-callback',
      resourceParts: [ticketId],
    });

    const callbackUrl = new URL(callbackTarget.url);
    expect(callbackUrl.origin).toBe('https://api.test');
    expect(callbackUrl.pathname).toBe('/api/internal/auto-fix/pr-callback');
    expect(callbackUrl.searchParams.get('ticketId')).toBe(ticketId);
    expect(callbackTarget.headers).toEqual({ 'X-Callback-Token': expectedToken });
    expect(callbackTarget.headers).not.toHaveProperty('X-Internal-Secret');
  });
});
