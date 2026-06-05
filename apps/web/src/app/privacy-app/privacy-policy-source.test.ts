import { afterEach, describe, expect, jest, test } from '@jest/globals';

import {
  extractPrivacyPolicyMainHtml,
  fetchPrivacyPolicyMainHtml,
  PRIVACY_POLICY_FALLBACK_HTML,
} from './privacy-policy-source';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

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

describe('fetchPrivacyPolicyMainHtml', () => {
  test('returns fallback content when the source request fails', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network unavailable');
    });

    await expect(fetchPrivacyPolicyMainHtml()).resolves.toBe(PRIVACY_POLICY_FALLBACK_HTML);
  });

  test('returns fallback content when the source returns an error status', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }) as Response);

    await expect(fetchPrivacyPolicyMainHtml()).resolves.toBe(PRIVACY_POLICY_FALLBACK_HTML);
  });

  test('returns fallback content when the source content cannot be parsed', async () => {
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          text: async () => '<html><body>No policy content</body></html>',
        }) as Response
    );

    await expect(fetchPrivacyPolicyMainHtml()).resolves.toBe(PRIVACY_POLICY_FALLBACK_HTML);
  });
});
