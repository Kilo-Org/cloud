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
});
