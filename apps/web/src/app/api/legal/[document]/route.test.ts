import { afterEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { stripLeadingDocumentTitle } from '@/app/legal-body';

import { GET } from './route';

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  jest.restoreAllMocks();
});

function request(document: string): Promise<Response> {
  return GET(new Request(`https://app.example.com/api/legal/${document}`), {
    params: Promise.resolve({ document }),
  });
}

describe('stripLeadingDocumentTitle', () => {
  test('removes the terms title card and the wrapper it leaves empty', () => {
    const terms = '<div><div><h3>Terms of Service</h3></div><div><p>body</p></div></div>';

    expect(stripLeadingDocumentTitle(terms)).toBe('<div><div><p>body</p></div></div>');
  });

  test('removes a leading H1 and keeps the wrapper that still holds content', () => {
    const privacy =
      '<h1>Privacy Policy</h1><div><div><p>Last Updated: May 29, 2026</p></div></div>';

    expect(stripLeadingDocumentTitle(privacy)).toBe(
      '<div><div><p>Last Updated: May 29, 2026</p></div></div>'
    );
  });

  test('keeps other content a wrapper holds beside the title', () => {
    expect(stripLeadingDocumentTitle('<div><h1>Terms</h1><p>body</p><p>more</p></div>')).toBe(
      '<div><p>body</p><p>more</p></div>'
    );
  });

  test('strips a leading heading of any level', () => {
    expect(stripLeadingDocumentTitle('<h2>Scope</h2><p>body</p>')).toBe('<p>body</p>');
    expect(stripLeadingDocumentTitle('<h4>Scope</h4><p>body</p>')).toBe('<p>body</p>');
    expect(stripLeadingDocumentTitle('<div><h4>Scope</h4></div><p>body</p>')).toBe('<p>body</p>');
  });

  test('allows leading whitespace before the title', () => {
    expect(stripLeadingDocumentTitle('  <h1>Privacy Policy</h1><p>body</p>')).toBe('<p>body</p>');
  });

  test('keeps later headings, anchors, and ids byte-identical', () => {
    expect(
      stripLeadingDocumentTitle(
        '<h1>Privacy Policy</h1><h2 id="s1">Scope</h2><p><a href="/terms" id="t1">terms</a></p>'
      )
    ).toBe('<h2 id="s1">Scope</h2><p><a href="/terms" id="t1">terms</a></p>');
  });

  test('serves a body that does not lead with a heading unchanged', () => {
    const body = '<p>Intro</p><h1>Later</h1><div><h3>Terms</h3></div>';

    expect(stripLeadingDocumentTitle(body)).toBe(body);
  });

  test('returns empty and whitespace-only input unchanged', () => {
    expect(stripLeadingDocumentTitle('')).toBe('');
    expect(stripLeadingDocumentTitle(' \n\t ')).toBe(' \n\t ');
  });

  test('leaves markup it cannot scan safely unchanged', () => {
    const unclosed = '<div><h1>Terms</h1><p>body</p>';

    expect(stripLeadingDocumentTitle(unclosed)).toBe(unclosed);
  });

  test('keeps void elements inside the remaining content', () => {
    expect(stripLeadingDocumentTitle('<h1>Terms</h1><p>a<br />b</p><hr />')).toBe(
      '<p>a<br />b</p><hr />'
    );
  });
});

describe('GET /api/legal/[document]', () => {
  test('serves the sanitized document without marketing links or a leading H1', async () => {
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          text: async () => `
            <main>
              <h1>Terms of Use</h1>
              <p>See <a href="https://kilo.ai/pricing">pricing</a>.</p>
            </main>
          `,
        }) as Response
    );

    const response = await request('terms');

    expect(response.status).toBe(200);
    const body: { html: string } = await response.json();
    expect(body.html).not.toContain('<h1>Terms of Use</h1>');
    expect(body.html).toContain('<span>pricing</span>');
    expect(body.html).not.toContain('kilo.ai/pricing');
  });

  test('serves the privacy document with the body intact and without a leading H1', async () => {
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          text: async () => `
            <main>
              <h1>Privacy Policy</h1>
              <p>body</p>
            </main>
          `,
        }) as Response
    );

    const response = await request('privacy');

    expect(response.status).toBe(200);
    const body: { html: string } = await response.json();
    expect(body.html).not.toContain('<h1>');
    expect(body.html).toContain('<p>body</p>');
  });

  test('strips a leading title that is not an H1', async () => {
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          text: async () => `
            <main>
              <div><div><h3>Terms of Service</h3></div><div><p>body</p></div></div>
            </main>
          `,
        }) as Response
    );

    const response = await request('terms');

    expect(response.status).toBe(200);
    const body: { html: string } = await response.json();
    expect(body.html).not.toContain('<h3>Terms of Service</h3>');
    expect(body.html).toContain('<p>body</p>');
  });

  test('refuses a document name it does not serve', async () => {
    const response = await request('invoices');

    expect(response.status).toBe(404);
  });

  test('reports an unreachable source as retryable', async () => {
    global.fetch = jest.fn(async () => {
      throw new Error('network unavailable');
    });

    const response = await request('privacy');

    expect(response.status).toBe(502);
  });
});
