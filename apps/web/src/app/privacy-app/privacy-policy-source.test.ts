import { describe, expect, test } from '@jest/globals';

import { extractPrivacyPolicyMainHtml } from './privacy-policy-source';

describe('extractPrivacyPolicyMainHtml', () => {
  test('keeps the policy content without source navigation or footer', () => {
    const html = `
      <header><a href="/pricing">Pricing</a></header>
      <main id="main">
        <h1>Privacy Policy</h1>
        <p>Policy body</p>
        <a href="/support">Support</a>
      </main>
      <footer><a href="/terms">Terms</a></footer>
    `;

    const result = extractPrivacyPolicyMainHtml(html);

    expect(result).toContain('Privacy Policy');
    expect(result).toContain('Policy body');
    expect(result).toContain('href="https://kilo.ai/support"');
    expect(result).not.toContain('Pricing');
    expect(result).not.toContain('Terms');
  });
});
