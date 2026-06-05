import { afterEach, describe, expect, jest, test } from '@jest/globals';

import { extractTermsMainHtml, fetchTermsMainHtml, TERMS_FALLBACK_HTML } from './terms-source';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe('extractTermsMainHtml', () => {
  test('keeps the terms content without source navigation or footer', () => {
    const html = `
      <header><a href="/pricing">Pricing</a></header>
      <main id="main">
        <h1>Terms of Service</h1>
        <p>Terms body</p>
        <a href="/support">Support</a>
      </main>
      <footer><a href="/privacy">Privacy</a></footer>
    `;

    const result = extractTermsMainHtml(html);

    expect(result).toContain('Terms of Service');
    expect(result).toContain('Terms body');
    expect(result).toContain('href="https://kilo.ai/support"');
    expect(result).not.toContain('Pricing');
    expect(result).not.toContain('Privacy');
  });
});

describe('fetchTermsMainHtml', () => {
  test('returns fallback content when the source request fails', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network unavailable');
    });

    await expect(fetchTermsMainHtml()).resolves.toBe(TERMS_FALLBACK_HTML);
  });

  test('returns fallback content when the source returns an error status', async () => {
    global.fetch = jest.fn(async () => ({ ok: false, status: 503 }) as Response);

    await expect(fetchTermsMainHtml()).resolves.toBe(TERMS_FALLBACK_HTML);
  });

  test('returns fallback content when the source content cannot be parsed', async () => {
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          text: async () => '<html><body>No terms content</body></html>',
        }) as Response
    );

    await expect(fetchTermsMainHtml()).resolves.toBe(TERMS_FALLBACK_HTML);
  });
});
