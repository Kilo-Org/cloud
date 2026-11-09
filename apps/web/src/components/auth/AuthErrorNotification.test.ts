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

  it('points new email signups at the other sign-in options', () => {
    const html = renderToStaticMarkup(
      createElement(AuthErrorNotification, { error: 'EMAIL-SIGNUP-DISABLED' })
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain('Email Sign-up Is Paused');
    expect(html).toContain('be created with email right now');
    expect(html).toContain('choose one of the other');
    expect(html).toContain('You can still sign in with email.');
  });

  it('uses the generic fallback for an unknown callback error', () => {
    const html = renderToStaticMarkup(
      createElement(AuthErrorNotification, { error: 'untrusted-query-error' })
    );

    expect(html).toContain('Oops! Something went wrong trying to log in.');
    expect(html).not.toContain('untrusted-query-error');
  });

  it.each([
    ['google,apple', ['Google', 'Apple'], []],
    ['apple', ['Apple'], ['Google']],
    ['apple,github,passkey,Apple,<b>x</b>', ['Apple'], ['Google', 'GitHub', 'Passkey', '<b>x</b>']],
    [undefined, [], ['Google', 'Apple']],
    ['github', [], ['Google', 'Apple', 'GitHub']],
  ])('names only known step-up methods from the query %s', (methods, named, absent) => {
    const html = renderToStaticMarkup(
      createElement(AuthErrorNotification, { error: 'SIGNUP-STEP-UP', stepUpMethods: methods })
    );

    expect(html).toContain('role="alert"');
    for (const name of named) expect(html).toContain(name);
    for (const name of absent) expect(html).not.toContain(name);
  });
});
