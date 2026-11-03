import { describe, expect, it } from '@jest/globals';
import { NextResponse } from 'next/server';
import type { User } from '@kilocode/db/schema';
import { ProxyErrorType } from '@kilocode/web-shared/lib/proxy-error-types';
import { INVALID_TOKEN_CODE } from '@kilocode/web-shared/lib/ai-gateway/llm-proxy-helpers';
import { resolveGatewayCaller } from '@kilocode/web-shared/lib/ai-gateway/gateway-admission';

const user = { id: 'user-1', google_user_email: 'user@example.com', microdollars_used: 5 } as User;

function authFailure(status: number, credentialsRejected: boolean) {
  return {
    user: null,
    authFailedResponse: NextResponse.json(
      { success: false as const, error: 'Auth failed' },
      { status }
    ),
    credentialsRejected,
  };
}

describe('resolveGatewayCaller', () => {
  it('resolves a verified user as signed in with its organization and bot', () => {
    const caller = resolveGatewayCaller(
      { user, authFailedResponse: null, organizationId: 'org-1', botId: 'bot-1' },
      { allowAnonymous: true, ipAddress: '192.0.2.1' }
    );

    expect(caller).toEqual({
      kind: 'signed-in',
      user,
      organizationId: 'org-1',
      botId: 'bot-1',
    });
  });

  it.each([
    {
      route: 'free-capable',
      resolve: (auth: ReturnType<typeof authFailure>) =>
        resolveGatewayCaller(auth, { allowAnonymous: true, ipAddress: '192.0.2.1' }),
    },
    {
      route: 'pass-through',
      resolve: (auth: ReturnType<typeof authFailure>) =>
        resolveGatewayCaller(auth, { allowAnonymous: false, passThroughAuthFailure: true }),
    },
  ])('answers a rejected credential with INVALID_TOKEN on a $route route', async ({ resolve }) => {
    const caller = resolve(authFailure(401, true));

    expect(caller.kind).toBe('rejected');
    if (caller.kind !== 'rejected') return;
    expect(caller.response.status).toBe(401);
    expect(caller.response.headers.get('WWW-Authenticate')).toBe('Bearer error="invalid_token"');
    await expect(caller.response.json()).resolves.toMatchObject({
      error: { code: INVALID_TOKEN_CODE },
    });
  });

  it('resolves a missing credential as anonymous when allowed and the IP is known', () => {
    const caller = resolveGatewayCaller(authFailure(401, false), {
      allowAnonymous: true,
      ipAddress: '192.0.2.1',
    });

    expect(caller).toMatchObject({
      kind: 'anonymous',
      user: { isAnonymous: true, ipAddress: '192.0.2.1', microdollars_used: 0 },
    });
  });

  it.each<{ allowAnonymous: boolean; ipAddress: string | undefined }>([
    { allowAnonymous: true, ipAddress: undefined },
    { allowAnonymous: false, ipAddress: '192.0.2.1' },
  ])('asks a caller without a credential to sign in: %j', async opts => {
    const caller = resolveGatewayCaller(authFailure(403, false), opts);

    expect(caller.kind).toBe('rejected');
    if (caller.kind !== 'rejected') return;
    expect(caller.response.status).toBe(401);
    await expect(caller.response.json()).resolves.toMatchObject({
      error: { code: 'PAID_MODEL_AUTH_REQUIRED' },
      error_type: ProxyErrorType.paid_model_auth_required,
    });
  });

  it('passes an auth failure without a rejected credential through when asked', () => {
    const auth = authFailure(403, false);

    const caller = resolveGatewayCaller(auth, {
      allowAnonymous: false,
      passThroughAuthFailure: true,
    });

    expect(caller).toEqual({ kind: 'rejected', response: auth.authFailedResponse });
  });
});
