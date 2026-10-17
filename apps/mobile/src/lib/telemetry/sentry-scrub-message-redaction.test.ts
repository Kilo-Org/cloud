import { describe, expect, it } from 'vitest';

import { scrubBreadcrumb, scrubEvent } from './sentry-scrub';

// Assembled from parts: the fixture is a URL component, not a credential URI.
const USERINFO = ['user', 'abcdefghijklmnopqrst'].join(':');

/**
 * The scrubber's message and URL coverage: the payload text Sentry shows — the
 * exception message, `event.message`, the app's `network` context — is
 * redacted, and a captured URL carries only its origin and path.
 */
describe('scrubEvent message redaction', () => {
  it('redacts a long opaque run in an exception value and keeps the text readable', () => {
    const event = {
      exception: {
        values: [
          { type: 'Error', value: 'upload failed for token abcdefghijklmnopqrst' },
          { type: 'Error', value: 'caused by key abcdefghijklmnopqrst' },
        ],
      },
    };

    const result = scrubEvent(event);
    const [first, second] = result.exception.values;

    expect(first?.value).toBe('upload failed for token [redacted]');
    expect(second?.value).toBe('caused by key [redacted]');
  });

  it('redacts a long opaque run in event.message', () => {
    const event = { message: 'sync failed for abcdefghijklmnopqrst' };

    const result = scrubEvent(event);

    expect(result.message).toBe('sync failed for [redacted]');
  });

  it('redacts free text in the network context and keeps the app-set names', () => {
    const event = {
      exception: { values: [{ type: 'TypeError' }] },
      contexts: {
        network: {
          url: 'https://api.example.com/api/trpc/cliSessionsV2.getSessionMessagesPage',
          procedure: 'cliSessionsV2.getSessionMessagesPage',
          trpcCode: 'INTERNAL_SERVER_ERROR',
          outcome: 'http_error',
          statusText: 'Upstream rejected my-super-secret-prod-token',
        },
      },
    };

    const result = scrubEvent(event);

    expect(result.contexts.network.url).toBe(
      'https://api.example.com/api/trpc/cliSessionsV2.getSessionMessagesPage'
    );
    expect(result.contexts.network.procedure).toBe('cliSessionsV2.getSessionMessagesPage');
    expect(result.contexts.network.trpcCode).toBe('INTERNAL_SERVER_ERROR');
    expect(result.contexts.network.outcome).toBe('http_error');
    expect(result.contexts.network.statusText).toBe('Upstream rejected [redacted]');
  });
});

describe('scrubEvent URL reduction', () => {
  it('reduces the network context URL to origin and path', () => {
    const withQuery = scrubEvent({
      contexts: {
        network: {
          url: 'https://api.example.com/api/trpc/session.list?input=abcdefghijklmnopqrst',
        },
      },
    });
    const withFragment = scrubEvent({
      contexts: {
        network: {
          url: 'https://api.example.com/oauth/callback#abcdefghijklmnopqrst',
        },
      },
    });

    expect(withQuery.contexts.network.url).toBe('https://api.example.com/api/trpc/session.list');
    expect(withFragment.contexts.network.url).toBe('https://api.example.com/oauth/callback');
  });

  it('redacts a long opaque path segment in the network context URL', () => {
    const event = {
      contexts: {
        network: { url: 'https://cdn.example.com/files/abcdefghijklmnopqrst/download' },
      },
    };

    const result = scrubEvent(event);

    expect(result.contexts.network.url).toBe('https://cdn.example.com/files/[redacted]/download');
  });

  it('reduces request.url to its origin and path', () => {
    const fragment = scrubEvent({
      request: { url: 'https://example.com/oauth/callback#abcdefghijklmnopqrst' },
    });
    const userinfo = scrubEvent({
      request: { url: `https://${USERINFO}@api.example.com/v1/latency` },
    });

    expect(fragment.request.url).toBe('https://example.com/oauth/callback');
    expect(userinfo.request.url).toBe('https://api.example.com/v1/latency');
  });
});

describe('scrubBreadcrumb URL reduction', () => {
  it('strips a fragment from breadcrumb data.url', () => {
    const breadcrumb = {
      category: 'navigation',
      data: { url: 'https://example.com/oauth/callback#abcdefghijklmnopqrst' },
    };

    const result = scrubBreadcrumb(breadcrumb);

    expect(result?.data.url).toBe('https://example.com/oauth/callback');
  });
});
