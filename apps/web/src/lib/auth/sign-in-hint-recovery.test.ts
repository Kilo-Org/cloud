import { shouldDiscardSsoHintOnError } from '@/lib/auth/sign-in-hint-recovery';

const ssoHint = { lastAuthMethod: 'workos', orgId: 'org_01KY7Q7B3W99QKBKYGWYK6SFK1' } as const;

describe('shouldDiscardSsoHintOnError', () => {
  it('discards an SSO hint when NextAuth rejects the WorkOS redirect', () => {
    // WorkOS answers `error=organization_invalid` for an organization with no
    // connection, which NextAuth surfaces as `Callback`.
    expect(shouldDiscardSsoHintOnError(ssoHint, 'Callback')).toBe(true);
  });

  it('discards an SSO hint for any other error code that lands on sign-in', () => {
    for (const error of [
      'OAuthCallback',
      'OAuthSignin',
      'AccessDenied',
      'OAUTH_ERROR',
      'DIFFERENT-OAUTH',
      'UNKNOWN-ERROR',
      'some unmapped thrown message',
    ]) {
      expect(shouldDiscardSsoHintOnError(ssoHint, error)).toBe(true);
    }
  });

  it('keeps the SSO hint when the page is not showing an error', () => {
    expect(shouldDiscardSsoHintOnError(ssoHint, undefined)).toBe(false);
    expect(shouldDiscardSsoHintOnError(ssoHint, null)).toBe(false);
    expect(shouldDiscardSsoHintOnError(ssoHint, '')).toBe(false);
  });

  it('keeps non-SSO hints, which always have a working escape hatch', () => {
    expect(shouldDiscardSsoHintOnError({ lastAuthMethod: 'google' }, 'Callback')).toBe(false);
    expect(shouldDiscardSsoHintOnError({ lastAuthMethod: 'email' }, 'Callback')).toBe(false);
    expect(shouldDiscardSsoHintOnError({ lastAuthMethod: 'github' }, 'OAuthCallback')).toBe(false);
  });

  it('keeps a workos hint that carries no organization id, since nothing is stale', () => {
    expect(shouldDiscardSsoHintOnError({ lastAuthMethod: 'workos' }, 'Callback')).toBe(false);
    expect(shouldDiscardSsoHintOnError({ lastAuthMethod: 'workos', orgId: '' }, 'Callback')).toBe(
      false
    );
  });

  it('tolerates a missing hint', () => {
    expect(shouldDiscardSsoHintOnError(null, 'Callback')).toBe(false);
    expect(shouldDiscardSsoHintOnError(undefined, 'Callback')).toBe(false);
  });
});
