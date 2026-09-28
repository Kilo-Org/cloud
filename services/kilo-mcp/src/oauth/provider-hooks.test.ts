import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenExchangeCallbackOptions } from '@cloudflare/workers-oauth-provider';
import { onError, tokenExchangeCallback, type OAuthProviderError } from './provider-hooks';
import type { McpAnalytics, OAuthSignInInput } from '../analytics';

const hook = tokenExchangeCallback;
const errorHook = onError;

// The library's GrantType values, as plain strings (no runtime library import).
const AUTHORIZATION_CODE = 'authorization_code' as TokenExchangeCallbackOptions['grantType'];
const REFRESH_TOKEN = 'refresh_token' as TokenExchangeCallbackOptions['grantType'];

function fakeAnalytics(): { analytics: McpAnalytics; calls: OAuthSignInInput[] } {
  const calls: OAuthSignInInput[] = [];
  return {
    calls,
    analytics: {
      oauthSignIn: vi.fn((input: OAuthSignInInput) => {
        calls.push(input);
      }),
    } as unknown as McpAnalytics,
  };
}

function exchangeOptions(
  overrides: Partial<TokenExchangeCallbackOptions> = {}
): TokenExchangeCallbackOptions {
  return {
    grantType: AUTHORIZATION_CODE,
    clientId: 'client-abc',
    userId: 'u-1',
    grantId: 'grant-1',
    scope: ['mcp'],
    requestedScope: ['mcp'],
    props: { kiloUserId: 'u-1', organizationId: 'org-1', kiloToken: 'kilo-tok' },
    ...overrides,
  };
}

describe('tokenExchangeCallback', () => {
  beforeEach(() => vi.clearAllMocks());

  it('emits oauthSignIn succeeded with the identity from the grant props', () => {
    const { analytics, calls } = fakeAnalytics();
    hook(exchangeOptions(), { analytics });
    expect(calls).toEqual([
      { phase: 'succeeded', identity: { kiloUserId: 'u-1', organizationId: 'org-1' } },
    ]);
  });

  it('reports a personal grant with a null organization', () => {
    const { analytics, calls } = fakeAnalytics();
    hook(
      exchangeOptions({
        props: { kiloUserId: 'u-2', organizationId: null, kiloToken: 'k' },
      }),
      { analytics }
    );
    expect(calls).toEqual([
      { phase: 'succeeded', identity: { kiloUserId: 'u-2', organizationId: null } },
    ]);
  });

  it('reports anonymously when the props carry no usable Kilo user id', () => {
    const { analytics, calls } = fakeAnalytics();
    hook(exchangeOptions({ props: null }), { analytics });
    hook(exchangeOptions({ props: { organizationId: 'org-1' } }), { analytics });
    hook(exchangeOptions({ props: { kiloUserId: '' } }), { analytics });
    expect(calls).toEqual([
      { phase: 'succeeded', identity: null },
      { phase: 'succeeded', identity: null },
      { phase: 'succeeded', identity: null },
    ]);
  });

  it('does not emit for a refresh-token exchange', () => {
    const { analytics, calls } = fakeAnalytics();
    hook(exchangeOptions({ grantType: REFRESH_TOKEN }), { analytics });
    expect(calls).toEqual([]);
  });

  it('is a no-op without an analytics emitter and never throws', () => {
    expect(() => hook(exchangeOptions())).not.toThrow();
    expect(() => tokenExchangeCallback(exchangeOptions())).not.toThrow();
  });
});

describe('onError', () => {
  it('emits oauthSignIn failed with the OAuth error code as reason', () => {
    const { analytics, calls } = fakeAnalytics();
    const error: OAuthProviderError = {
      code: 'invalid_grant',
      description: 'bad',
      status: 400,
      headers: {},
    };
    errorHook(error, { analytics });
    expect(calls).toEqual([{ phase: 'failed', identity: null, reason: 'invalid_grant' }]);
  });

  it('is a no-op without an analytics emitter and never throws', () => {
    expect(() =>
      onError({ code: 'server_error', description: 'x', status: 500, headers: {} })
    ).not.toThrow();
  });
});
