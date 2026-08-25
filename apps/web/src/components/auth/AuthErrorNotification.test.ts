import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthErrorNotification } from './AuthErrorNotification';

describe('AuthErrorNotification', () => {
  it('announces global authentication errors atomically', () => {
    const html = renderToStaticMarkup(
      createElement(AuthErrorNotification, { error: 'LINKING-FAILED' })
    );

    expect(html).toContain('data-error-notification="true"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain('Account Linking Failed');
  });

  it.each([
    [
      'DISCOVERY_RATE_LIMITED',
      'Too Many Attempts',
      'Too many sign-in attempts. Please try again later.',
    ],
    [
      'DISCOVERY_FAILED',
      'Sign-in Methods Unavailable',
      'We could not find your sign-in methods. Please try again.',
    ],
    [
      'NO_SUPPORTED_SIGN_IN_METHOD',
      'No Supported Sign-in Method',
      'No supported sign-in method is available for this account. Use a different email.',
    ],
    [
      'MAGIC_LINK_DELIVERY_FAILED',
      'Magic Link Not Sent',
      'We could not send your magic link. Please try again.',
    ],
  ])('presents controlled operational error %s', (error, title, message) => {
    const html = renderToStaticMarkup(createElement(AuthErrorNotification, { error }));

    expect(html).toContain('role="alert"');
    expect(html).toContain('aria-live="assertive"');
    expect(html).toContain(title);
    expect(html).toContain(message);
  });

  it('uses the generic fallback for an unknown callback error', () => {
    const html = renderToStaticMarkup(
      createElement(AuthErrorNotification, { error: 'untrusted-query-error' })
    );

    expect(html).toContain('Oops! Something went wrong trying to log in.');
    expect(html).not.toContain('untrusted-query-error');
  });
});
