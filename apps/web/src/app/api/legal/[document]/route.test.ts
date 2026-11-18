import { afterEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

import { GET, stripLeadingTitleHeading } from './route';

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

describe('stripLeadingTitleHeading', () => {
  test('removes an H1 element that opens the document', () => {
    expect(stripLeadingTitleHeading('<h1>Privacy Policy</h1><p>body</p>')).toBe('<p>body</p>');
  });

  test('allows leading whitespace before the H1', () => {
    expect(stripLeadingTitleHeading('  <h1>Privacy Policy</h1><p>body</p>')).toBe('<p>body</p>');
  });

  test('keeps an H1 that is not the first element', () => {
    expect(stripLeadingTitleHeading('<p>x</p><h1>Later</h1>')).toBe('<p>x</p><h1>Later</h1>');
  });

  test('keeps a document that does not start with an H1 unchanged', () => {
    expect(stripLeadingTitleHeading('<div><h3>Terms</h3><p>body</p></div>')).toBe(
      '<div><h3>Terms</h3><p>body</p></div>'
    );
  });

  test('keeps later headings, anchors, and ids intact', () => {
    expect(
      stripLeadingTitleHeading(
        '<h1>Privacy Policy</h1><h2 id="s1">Scope</h2><p><a href="/terms" id="t1">terms</a></p>'
      )
    ).toBe('<h2 id="s1">Scope</h2><p><a href="/terms" id="t1">terms</a></p>');
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

  test('serves a document without a leading H1 unchanged', async () => {
    global.fetch = jest.fn(
      async () =>
        ({
          ok: true,
          text: async () => `
            <main>
              <div><h3>Terms of Service</h3><p>body</p></div>
            </main>
          `,
        }) as Response
    );

    const response = await request('terms');

    expect(response.status).toBe(200);
    const body: { html: string } = await response.json();
    expect(body.html).toContain('<h3>Terms of Service</h3>');
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
