import { describe, expect, test } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { AuthErrorNotification } from './AuthErrorNotification';

// The component's JSX compiles to `React.createElement`, and Next supplies the
// binding its own build; here it comes from the test.
Object.assign(globalThis, { React });

describe('AuthErrorNotification', () => {
  test('links support from the full web app', () => {
    const html = renderToStaticMarkup(
      createElement(AuthErrorNotification, { error: 'SIGNUP-RATE-LIMITED' })
    );

    expect(html).toContain('href="https://kilo.ai/support"');
  });

  // The app shell renders no link out of itself, and the sign-in error text is
  // the one place this component would otherwise send the user to marketing.
  test.each(['SIGNUP-RATE-LIMITED', 'EMAIL-ALREADY-USED'])(
    '%s mentions support without a link inside the app shell',
    error => {
      const html = renderToStaticMarkup(
        createElement(AuthErrorNotification, { error, shell: true })
      );

      expect(html).toContain('contact support');
      expect(html).not.toContain('<a');
      expect(html).not.toContain('href=');
    }
  );

  test('the blocked-account notice renders no link inside the app shell', () => {
    const html = renderToStaticMarkup(
      createElement(AuthErrorNotification, { error: 'BLOCKED', shell: true })
    );

    expect(html).toContain('Account Blocked');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('href=');
  });
});
