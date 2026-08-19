import { describe, expect, it } from 'vitest';

import { scrubBreadcrumb, scrubEvent } from './sentry-scrub';

describe('scrubEvent', () => {
  it('strips query strings from request.url', () => {
    const event = {
      request: { url: 'https://api.example.com/trpc/getUser?input=%7B%22id%22%3A%221%22%7D' },
    };

    const result = scrubEvent(event);

    expect(result.request.url).toBe('https://api.example.com/trpc/getUser');
  });

  it('strips query strings from request.url with repo and org params', () => {
    const event = {
      request: { url: 'https://api.example.com/data?repo=kilocode&org=myorg' },
    };

    const result = scrubEvent(event);

    expect(result.request.url).toBe('https://api.example.com/data');
  });

  it('strips query strings from contexts.response.url', () => {
    const event = {
      contexts: { response: { url: 'https://cdn.example.com/file?token=abc' } },
    };

    const result = scrubEvent(event);

    expect(result.contexts.response.url).toBe('https://cdn.example.com/file');
  });

  it('deletes user.email', () => {
    const event = {
      user: { email: 'user@example.com', id: 'abc' },
    };

    const result = scrubEvent(event);

    expect(result.user.email).toBeUndefined();
    expect(result.user.id).toBe('abc');
  });

  it('deletes user.username', () => {
    const event = {
      user: { username: 'jdoe', id: 'abc' },
    };

    const result = scrubEvent(event);

    expect(result.user.username).toBeUndefined();
    expect(result.user.id).toBe('abc');
  });

  it('deletes user.ip_address', () => {
    const event = {
      user: { ip_address: '1.2.3.4', id: 'abc' },
    };

    const result = scrubEvent(event);

    expect(result.user.ip_address).toBeUndefined();
    expect(result.user.id).toBe('abc');
  });

  it('redacts Bearer token values in extra', () => {
    const event = {
      extra: { auth: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0' },
    };

    const result = scrubEvent(event);

    expect(result.extra.auth).toBe('[redacted]');
  });

  it('redacts long base64url token values in extra', () => {
    const event = {
      extra: { token: 'abcdefghijklmnopqrst' },
    };

    const result = scrubEvent(event);

    expect(result.extra.token).toBe('[redacted]');
  });

  it('does not redact short non-token values in extra', () => {
    const event = {
      extra: { count: 42, name: 'short' },
    };

    const result = scrubEvent(event);

    expect(result.extra.count).toBe(42);
    expect(result.extra.name).toBe('short');
  });

  it('redacts token values in tags', () => {
    const event = {
      tags: { session: 'Bearer tok1234567890abcdef' },
    };

    const result = scrubEvent(event);

    expect(result.tags.session).toBe('[redacted]');
  });

  it('returns malformed event unchanged without throwing', () => {
    const event = null;
    expect(() => scrubEvent(event)).not.toThrow();
    expect(scrubEvent(event)).toBe(null);
  });

  it('returns undefined unchanged without throwing', () => {
    expect(() => {
      scrubEvent<Record<string, unknown> | undefined>(undefined);
    }).not.toThrow();
    expect(scrubEvent<Record<string, unknown> | undefined>(undefined)).toBeUndefined();
  });

  it('returns string input unchanged without throwing', () => {
    expect(() => scrubEvent('bad')).not.toThrow();
    expect(scrubEvent('bad')).toBe('bad');
  });

  it('returns number input unchanged without throwing', () => {
    expect(() => scrubEvent(42)).not.toThrow();
    expect(scrubEvent(42)).toBe(42);
  });

  it('handles event with null request gracefully', () => {
    const event = { request: null, user: {} };
    expect(() => scrubEvent(event)).not.toThrow();
  });

  it('handles event with null contexts gracefully', () => {
    const event = { contexts: null, user: {} };
    expect(() => scrubEvent(event)).not.toThrow();
  });

  it('handles event with null user gracefully', () => {
    const event = { request: { url: 'https://x.com/path?q=1' }, user: null };
    expect(() => scrubEvent(event)).not.toThrow();
  });

  it('leaves URL without query string unchanged', () => {
    const event = { request: { url: 'https://api.example.com/trpc/getUser' } };

    const result = scrubEvent(event);

    expect(result.request.url).toBe('https://api.example.com/trpc/getUser');
  });

  it('does not mutate extra when no token values present', () => {
    const event = { extra: { env: 'production', build: 123 } };

    const result = scrubEvent(event);

    expect(result.extra).toEqual({ env: 'production', build: 123 });
  });
});

describe('scrubBreadcrumb', () => {
  it('returns null for console breadcrumbs', () => {
    const breadcrumb = {
      category: 'console',
      message: 'User prompt: secret stuff',
    };

    expect(scrubBreadcrumb(breadcrumb)).toBeNull();
  });

  it('keeps navigation breadcrumbs intact', () => {
    const breadcrumb = {
      category: 'navigation',
      message: 'Navigated to /home',
    };

    const result = scrubBreadcrumb(breadcrumb);

    expect(result).toEqual(breadcrumb);
  });

  it('keeps fetch breadcrumbs intact', () => {
    const breadcrumb = {
      category: 'fetch',
      data: { method: 'GET' },
    };

    const result = scrubBreadcrumb(breadcrumb);

    expect(result).toEqual(breadcrumb);
  });

  it('strips query string from breadcrumb data.url', () => {
    const breadcrumb = {
      category: 'navigation',
      data: { url: 'https://example.com/page?secret=123', method: 'GET' },
    };

    const result = scrubBreadcrumb(breadcrumb);

    expect(result?.data.url).toBe('https://example.com/page');
    expect(result?.data.method).toBe('GET');
  });

  it('returns null input unchanged without throwing', () => {
    expect(() => scrubBreadcrumb(null)).not.toThrow();
    expect(scrubBreadcrumb(null)).toBeNull();
  });

  it('returns undefined input unchanged without throwing', () => {
    expect(() => scrubBreadcrumb(undefined)).not.toThrow();
    expect(scrubBreadcrumb(undefined)).toBeUndefined();
  });

  it('returns string input unchanged without throwing', () => {
    expect(() => scrubBreadcrumb('bad')).not.toThrow();
    expect(scrubBreadcrumb('bad')).toBe('bad');
  });

  it('handles breadcrumb with null data gracefully', () => {
    const breadcrumb = { category: 'navigation', data: null };
    expect(() => scrubBreadcrumb(breadcrumb)).not.toThrow();
  });
});
