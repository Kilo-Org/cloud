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

    expect(result?.request).toEqual({
      url: 'https://api.example.com/trpc/getUser',
      headers: {
        'Content-Type': 'application/json',
        accept: 'application/json',
        'User-Agent': 'kilo-app/1.0',
      },
    });
  });

  it('drops env, string headers, and fields outside method, url, and headers', () => {
    const result = scrubEvent({
      request: {
        method: 'POST',
        url: 'https://api.example.com/a',
        headers: 'Authorization: Bearer fake-token-value',
        env: { HTTP_COOKIE: 'session=fake-cookie-value', REMOTE_ADDR: '192.0.2.1' },
        fragment: 'fake-fragment-value',
      },
    });

    expect(result?.request).toEqual({ method: 'POST', url: 'https://api.example.com/a' });
  });

  it('drops allowlisted headers whose value is not a string', () => {
    const result = scrubEvent({
      request: {
        headers: {
          accept: ['application/json', 'Bearer fake-token-value'],
          'Content-Type': { value: 'fake-header-value' },
          'User-Agent': 'kilo-app/1.0',
        },
      },
    });

    expect(result?.request).toEqual({ headers: { 'User-Agent': 'kilo-app/1.0' } });
  });

  it('leaves a request with no headers otherwise unchanged', () => {
    const result = scrubEvent({ request: { url: 'https://api.example.com/a', method: 'GET' } });

    expect(result?.request).toEqual({ url: 'https://api.example.com/a', method: 'GET' });
  });
});
