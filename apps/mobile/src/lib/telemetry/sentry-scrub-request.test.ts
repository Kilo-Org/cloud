import { describe, expect, it } from 'vitest';

import { scrubEvent } from './sentry-scrub';

describe('request scrubbing', () => {
  it('removes request cookies, data, query string, and non-allowlisted headers', () => {
    const event = {
      request: {
        url: 'https://api.example.com/trpc/getUser?token=fake-token-value',
        query_string: 'token=fake-token-value',
        cookies: { session: 'fake-cookie-value' },
        data: { password: 'fake-password' },
        headers: {
          Authorization: 'Bearer fake-token-value',
          Cookie: 'session=fake-cookie-value',
          'x-foo': 'fake-header-value',
          'Content-Type': 'application/json',
          accept: 'application/json',
          'User-Agent': 'kilo-app/1.0',
        },
      },
    };

    const result = scrubEvent(event);

    expect(result.request).toEqual({
      url: 'https://api.example.com/trpc/getUser',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
        'User-Agent': 'kilo-app/1.0',
      },
    });
  });

  it('leaves a request with no headers otherwise unchanged', () => {
    const result = scrubEvent({ request: { url: 'https://api.example.com/a', method: 'GET' } });

    expect(result.request).toEqual({ url: 'https://api.example.com/a', method: 'GET' });
  });
});
