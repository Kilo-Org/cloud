import { describe, expect, it } from 'vitest';
import { runtimeAuthorizationLifetime } from './runtime-authorization-lifetime.js';

describe('runtimeAuthorizationLifetime', () => {
  it('shortens delegations only in development', () => {
    expect(
      runtimeAuthorizationLifetime({
        ENVIRONMENT: 'development',
        RUNTIME_AUTHORIZATION_LIFETIME_MS: '300000',
      } as never)
    ).toEqual({ lifetimeMs: 300_000 });
    expect(
      runtimeAuthorizationLifetime({
        ENVIRONMENT: 'production',
        RUNTIME_AUTHORIZATION_LIFETIME_MS: '300000',
      } as never)
    ).toEqual({});
  });

  it.each(['59999', '86400001', '5m', ''])('ignores the out-of-range value %j', value => {
    expect(
      runtimeAuthorizationLifetime({
        ENVIRONMENT: 'development',
        RUNTIME_AUTHORIZATION_LIFETIME_MS: value,
      } as never)
    ).toEqual({});
  });
});
