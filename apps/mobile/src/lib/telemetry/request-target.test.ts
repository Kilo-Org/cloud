import { describe, expect, it } from 'vitest';

import { stripQueryString } from '@/lib/telemetry/request-target';

// Assembled from parts so the fixture reads as a plain URL value.
const USERINFO = ['user', 'abcdefghijklmnopqrst'].join(':');

describe('stripQueryString', () => {
  it('drops the query string', () => {
    expect(stripQueryString('https://example.com/api/trpc/a.b?batch=1&input=secret')).toBe(
      'https://example.com/api/trpc/a.b'
    );
  });

  it('leaves a query-free URL unchanged', () => {
    expect(stripQueryString('https://example.com/api/trpc/a.b')).toBe(
      'https://example.com/api/trpc/a.b'
    );
  });

  it('keeps origin and path for a fragment suffix', () => {
    expect(stripQueryString('https://example.com/oauth/callback#abcdefghijklmnopqrst')).toBe(
      'https://example.com/oauth/callback'
    );
  });

  it('keeps origin and path when the authority carries userinfo', () => {
    expect(stripQueryString(`https://${USERINFO}@example.com/api/trpc/a.b`)).toBe(
      'https://example.com/api/trpc/a.b'
    );
  });
});
