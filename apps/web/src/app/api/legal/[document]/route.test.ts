import { afterEach, describe, expect, jest, test } from '@jest/globals';

jest.mock('@sentry/nextjs', () => ({ captureException: jest.fn() }));

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

describe('GET /api/legal/[document]', () => {
  test('returns the sanitized document without marketing links', async () => {
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
    expect(body.html).toContain('<h1>Terms of Use</h1>');
    expect(body.html).toContain('<span>pricing</span>');
    expect(body.html).not.toContain('kilo.ai/pricing');
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
