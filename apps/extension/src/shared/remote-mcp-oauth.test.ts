import { describe, expect, it } from 'vitest';
import {
  buildPublicClientMetadata,
  generateOAuthState,
  isOAuthTokenExpired,
  parseAuthorizationRedirect,
} from './remote-mcp-oauth';

describe('generateOAuthState', () => {
  it('produces distinct values across calls', () => {
    const values = new Set(Array.from({ length: 16 }, () => generateOAuthState()));
    expect(values.size).toBe(16);
  });

  it('produces a non-empty string', () => {
    expect(generateOAuthState().length).toBeGreaterThan(0);
  });
});

describe('parseAuthorizationRedirect', () => {
  const redirectBase = 'https://abc.chromiumapp.org/remote-mcp';

  it('extracts code and state from a successful redirect', () => {
    const result = parseAuthorizationRedirect(`${redirectBase}?code=the-code&state=the-state`);
    expect(result).toStrictEqual({ code: 'the-code', state: 'the-state' });
  });

  it('extracts code when no state is present', () => {
    const result = parseAuthorizationRedirect(`${redirectBase}?code=the-code`);
    expect(result).toStrictEqual({ code: 'the-code', state: undefined });
  });

  it('throws when code is missing', () => {
    expect(() => parseAuthorizationRedirect(`${redirectBase}?state=the-state`)).toThrow();
  });

  it('throws when the redirect carries an OAuth error', () => {
    expect(() =>
      parseAuthorizationRedirect(`${redirectBase}?error=access_denied&error_description=nope`)
    ).toThrow(/access_denied/);
  });

  it('throws on a malformed redirect URL', () => {
    expect(() => parseAuthorizationRedirect('not a url')).toThrow();
  });
});

describe('isOAuthTokenExpired', () => {
  it('treats tokens with no expiry as not expired', () => {
    expect(isOAuthTokenExpired(undefined, Date.now())).toBe(false);
  });

  it('returns false before expiry', () => {
    const now = 1_000_000;
    expect(isOAuthTokenExpired(now + 60_000, now)).toBe(false);
  });

  it('returns true at or after expiry', () => {
    const now = 1_000_000;
    expect(isOAuthTokenExpired(now, now)).toBe(true);
    expect(isOAuthTokenExpired(now - 1, now)).toBe(true);
  });
});

describe('buildPublicClientMetadata', () => {
  it('builds public-client PKCE metadata for the given redirect URL', () => {
    const metadata = buildPublicClientMetadata('https://abc.chromiumapp.org/remote-mcp');
    expect(metadata.redirect_uris).toStrictEqual(['https://abc.chromiumapp.org/remote-mcp']);
    expect(metadata.token_endpoint_auth_method).toBe('none');
    expect(metadata.grant_types).toContain('authorization_code');
    expect(metadata.grant_types).toContain('refresh_token');
    expect(metadata.response_types).toContain('code');
  });
});
