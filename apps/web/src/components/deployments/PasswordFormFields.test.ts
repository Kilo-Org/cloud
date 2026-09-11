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

function visibilityToggles(html: string): string[] {
  return html.match(/<button type="button" aria-label="Show password"[^>]*>/g) ?? [];
}

describe('PasswordProtection accessibility', () => {
  it('keeps every password visibility toggle keyboard reachable and state-labeled', () => {
    const toggles = visibilityToggles(render(true));

    expect(toggles).toHaveLength(2);
    for (const toggle of toggles) {
      expect(toggle).not.toContain('tabindex="-1"');
      expect(toggle).toContain('aria-pressed="false"');
      expect(toggle).toContain('aria-controls="password confirm-password"');
    }
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
