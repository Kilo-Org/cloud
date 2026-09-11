import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from '@jest/globals';
import { PasswordProtection } from './PasswordFormFields';

function render(enabled: boolean) {
  return renderToStaticMarkup(
    React.createElement(PasswordProtection, {
      value: { password: '', confirmPassword: '', enabled },
      onChange: () => undefined,
    })
  );
}

function firstVisibilityToggle(html: string): string {
  return html.match(/<button type="button" aria-label="Show password"[^>]*>/)?.[0] ?? '';
}

describe('PasswordProtection accessibility', () => {
  it('keeps the password visibility toggle keyboard reachable and state-labeled', () => {
    const toggle = firstVisibilityToggle(render(true));

    expect(toggle).not.toBe('');
    expect(toggle).not.toContain('tabindex="-1"');
    expect(toggle).toContain('aria-pressed="false"');
    expect(toggle).toContain('aria-controls="password confirm-password"');
  });

  it('associates the password requirements hint with the password input', () => {
    const html = render(true);

    expect(html).toContain('id="password-requirements"');
    expect(html).toContain('aria-describedby="password-requirements"');
  });

  it('does not render password fields while protection is disabled', () => {
    const html = render(false);

    expect(html).not.toContain('id="password"');
  });
});
