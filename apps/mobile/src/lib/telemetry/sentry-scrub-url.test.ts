import { describe, expect, it } from 'vitest';

import { redactUrlText, scrubBreadcrumb, scrubEvent } from './sentry-scrub';

// Assembled from parts so each fixture reads as a plain URL value.
const SECRET = ['abcdefghij', 'klmnopqrst'].join('/');
const TARGET = `https://user:${SECRET}@example.com/api/trpc/a.b`;
const ORIGIN_AND_PATH = 'https://example.com/api/trpc/a.b';

describe('URL reduction in the scrubbers', () => {
  it('keeps origin and path for a multi-part authority secret', () => {
    const result = redactUrlText(TARGET);

    expect(result).toBe(ORIGIN_AND_PATH);
    expect(result).not.toContain('abcdefghij');
  });

  it('keeps origin and path for the reported network context URL', () => {
    const result = scrubEvent({ contexts: { network: { url: TARGET } } });

    expect(result.contexts.network.url).toBe(ORIGIN_AND_PATH);
  });

  it('keeps origin and path for an http breadcrumb URL', () => {
    const result = scrubBreadcrumb({
      category: 'http',
      data: { method: 'GET', status_code: 500, url: TARGET },
    });

    expect(result?.data.url).toBe(ORIGIN_AND_PATH);
    expect(result?.data.method).toBe('GET');
    expect(result?.data.status_code).toBe(500);
  });
});
