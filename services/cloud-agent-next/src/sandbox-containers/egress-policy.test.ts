import { describe, expect, it } from 'vitest';
import { isAllowedEgressUrl, nativeEgressAllowlistSchema } from './egress-policy.js';

describe('native egress policy', () => {
  it('normalizes and deduplicates the effective allowlist without the public input cap', () => {
    const domains = Array.from({ length: 110 }, (_, index) => `host${index}.example.com`);
    expect(nativeEgressAllowlistSchema.parse(['Example.COM.', 'example.com', ...domains])).toEqual(
      ['example.com', ...domains].sort()
    );
  });

  it.each(
    [null, '*', ['*.example.com'], ['https://example.com'], ['127.0.0.1'], ['[::1]'], [123]].map(
      policy => ({ policy })
    )
  )('rejects malformed policies: %j', ({ policy }) => {
    expect(nativeEgressAllowlistSchema.safeParse(policy).success).toBe(false);
  });

  it.each([
    'http://example.com/path',
    'http://example.com:80/path',
    'https://example.com/path',
    'https://EXAMPLE.COM:443/path',
    'https://example.com./path',
  ])('allows exact canonical hostnames on standard ports: %s', target => {
    expect(isAllowedEgressUrl(new URL(target), ['example.com'])).toBe(true);
  });

  it.each([
    'https://sub.example.com/',
    'https://example.com.evil.test/',
    'https://example.com:8443/',
    'http://example.com:443/',
    'https://example.com:80/',
    'ftp://example.com/',
    'ws://example.com/',
    'https://user:password@example.com/',
    'http://127.0.0.1/',
    'http://2130706433/',
    'http://0x7f000001/',
    'https://[::1]/',
    'http://localhost/',
  ])('denies non-domain or nonstandard destinations: %s', target => {
    expect(isAllowedEgressUrl(new URL(target), ['example.com'])).toBe(false);
  });

  it('denies every destination for an empty effective allowlist', () => {
    expect(isAllowedEgressUrl(new URL('https://example.com/'), [])).toBe(false);
  });
});
