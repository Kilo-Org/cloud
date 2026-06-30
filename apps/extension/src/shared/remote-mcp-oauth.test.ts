import { describe, expect, it } from 'vitest';
import { buildPublicClientMetadata, parseAuthorizationRedirect } from './remote-mcp-oauth';

describe('authorization redirect parsing', () => {
  const redirectBase = 'https://abc.chromiumapp.org/remote-mcp';

  it('extracts the code from a successful redirect', () => {
    expect(parseAuthorizationRedirect(`${redirectBase}?code=the-code&state=the-state`)).toBe(
      'the-code'
    );
  });

  it('throws when code is missing', () => {
    expect(() => parseAuthorizationRedirect(`${redirectBase}?state=the-state`)).toThrow(/code/);
  });

  it('throws when the redirect carries an OAuth error', () => {
    expect(() =>
      parseAuthorizationRedirect(`${redirectBase}?error=access_denied&error_description=nope`)
    ).toThrow(/access_denied/);
  });

  it('throws on a malformed redirect URL', () => {
    expect(() => parseAuthorizationRedirect('not a url')).toThrow(Error);
  });
});

describe('public client metadata builder', () => {
  it('builds public-client PKCE metadata for the given redirect URL', () => {
    const metadata = buildPublicClientMetadata('https://abc.chromiumapp.org/remote-mcp');
    expect(metadata.redirect_uris).toStrictEqual(['https://abc.chromiumapp.org/remote-mcp']);
    expect(metadata.token_endpoint_auth_method).toBe('none');
    expect(metadata.grant_types).toContain('authorization_code');
    expect(metadata.grant_types).toContain('refresh_token');
    expect(metadata.response_types).toContain('code');
  });
});
