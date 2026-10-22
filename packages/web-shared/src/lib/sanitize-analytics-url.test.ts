import {
  isSharedSessionPath,
  sanitizeAnalyticsPathname,
  sanitizeAnalyticsText,
  sanitizeAnalyticsUrl,
  sanitizeAnalyticsUrlValue,
} from '@kilocode/web-shared/lib/sanitize-analytics-url';

describe('sanitizeAnalyticsUrl', () => {
  it('drops all query params from magic link verification URLs', () => {
    expect(
      sanitizeAnalyticsUrl(
        'https://app.kilo.ai',
        '/auth/verify-magic-link',
        'token=secret&email=user%40example.com&callbackUrl=%2Fprofile'
      )
    ).toBe('https://app.kilo.ai/auth/verify-magic-link');
  });

  it('removes sensitive query params from other URLs', () => {
    expect(
      sanitizeAnalyticsUrl(
        'https://app.kilo.ai',
        '/users/sign_in',
        'email=user%40example.com&state=secret&foo=bar&Token=abc'
      )
    ).toBe('https://app.kilo.ai/users/sign_in?foo=bar');
  });

  it('preserves non-sensitive query params', () => {
    expect(sanitizeAnalyticsUrl('https://app.kilo.ai', '/credits', 'tab=usage&page=2')).toBe(
      'https://app.kilo.ai/credits?tab=usage&page=2'
    );
  });

  it('sanitizes full analytics URL property values', () => {
    expect(
      sanitizeAnalyticsUrlValue(
        'https://app.kilo.ai/users/sign_in?email=user%40example.com&state=secret&foo=bar'
      )
    ).toBe('https://app.kilo.ai/users/sign_in?foo=bar');
  });

  it('leaves non-URL property values unchanged', () => {
    expect(sanitizeAnalyticsUrlValue('not a url')).toBe('not a url');
    expect(sanitizeAnalyticsUrlValue(null)).toBeNull();
  });

  it('redacts share tokens from /s/* pathnames', () => {
    expect(
      sanitizeAnalyticsUrl(
        'https://app.kilo.ai',
        '/s/eyJhbGciOiJIUzI1NiJ9.share.token',
        'utm_source=copy'
      )
    ).toBe('https://app.kilo.ai/s/:share_token?utm_source=copy');
    expect(
      sanitizeAnalyticsUrlValue(
        'https://app.kilo.ai/s/eyJhbGciOiJIUzI1NiJ9.share.token?email=user%40example.com'
      )
    ).toBe('https://app.kilo.ai/s/:share_token');
    expect(sanitizeAnalyticsUrlValue('/s/eyJhbGciOiJIUzI1NiJ9.share.token')).toBe(
      'http://localhost/s/:share_token'
    );
  });

  it('redacts legacy /share/* pathnames', () => {
    expect(sanitizeAnalyticsUrl('https://app.kilo.ai', '/share/abc', '')).toBe(
      'https://app.kilo.ai/share/:share_id'
    );
    expect(sanitizeAnalyticsUrlValue('https://app.kilo.ai/share/abc?tab=preview')).toBe(
      'https://app.kilo.ai/share/:share_id?tab=preview'
    );
  });

  it('redacts share capabilities embedded in editor URLs', () => {
    expect(
      sanitizeAnalyticsUrlValue(
        'vscode://kilocode.kilo-code/kilocode/s/eyJhbGciOiJIUzI1NiJ9.share.token'
      )
    ).toBe('vscode://kilocode.kilo-code/kilocode/s/:share_token');
    expect(
      sanitizeAnalyticsUrlValue(
        'cursor://kilocode.kilo-code/kilocode/share/9a5f0c84-1b04-4f6e-9e4f-37ed356a9f42'
      )
    ).toBe('cursor://kilocode.kilo-code/kilocode/share/:share_id');
  });

  it('redacts share capabilities in arbitrary analytics text', () => {
    expect(
      sanitizeAnalyticsText(
        'a:attr__href="vscode://kilocode.kilo-code/kilocode/s/eyJhbGciOiJIUzI1NiJ9.share.token"'
      )
    ).toBe('a:attr__href="vscode://kilocode.kilo-code/kilocode/s/:share_token"');
  });

  it('leaves neighboring paths unchanged', () => {
    expect(sanitizeAnalyticsUrl('https://app.kilo.ai', '/sessions/abc', '')).toBe(
      'https://app.kilo.ai/sessions/abc'
    );
    expect(sanitizeAnalyticsUrl('https://app.kilo.ai', '/shares/abc', '')).toBe(
      'https://app.kilo.ai/shares/abc'
    );
  });

  it('identifies both current and legacy share paths', () => {
    expect(isSharedSessionPath('/s/token')).toBe(true);
    expect(isSharedSessionPath('/s')).toBe(true);
    expect(isSharedSessionPath('/share/abc')).toBe(true);
    expect(isSharedSessionPath('/share')).toBe(true);
    expect(isSharedSessionPath('/sessions/abc')).toBe(false);
  });

  it('redacts share pathnames without changing unrelated pathnames', () => {
    expect(sanitizeAnalyticsPathname('/s/token')).toBe('/s/:share_token');
    expect(sanitizeAnalyticsPathname('/share/abc')).toBe('/share/:share_id');
    expect(sanitizeAnalyticsPathname('/cloud/sessions')).toBe('/cloud/sessions');
  });
});
