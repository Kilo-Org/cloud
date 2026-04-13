import { sanitizeAnalyticsUrl } from '@/lib/sanitize-analytics-url';

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
});
