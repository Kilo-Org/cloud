import { describe, expect, it } from 'vitest';
import { egressAllowlistSchema, egressDomainSchema } from './egress-allowlist.js';

describe('egressAllowlistSchema', () => {
  it('normalizes, sorts, and deduplicates exact DNS names', () => {
    expect(egressAllowlistSchema.parse(['Z.Example.COM.', 'example.com', 'EXAMPLE.COM.'])).toEqual([
      'example.com',
      'z.example.com',
    ]);
    expect(egressDomainSchema.parse('a-b.123.example')).toBe('a-b.123.example');
  });

  it('distinguishes omitted policy from baseline-only policy', () => {
    expect(egressAllowlistSchema.optional().parse(undefined)).toBeUndefined();
    expect(egressAllowlistSchema.parse([])).toEqual([]);
    expect(egressAllowlistSchema.safeParse(null).success).toBe(false);
  });

  it.each([
    'https://example.com',
    'example.com/path',
    'example.com:443',
    'user@example.com',
    '*.example.com',
    '*',
    'localhost',
    '127.0.0.1',
    '127.1',
    '2130706433',
    '0x7f000001',
    '0x7f.1',
    '0177.0.0.1',
    '127.0.0.1.',
    '[::1]',
    '::1',
    'example..com',
    '.example.com',
    'example.com..',
    '-example.com',
    'example-.com',
    'under_score.example.com',
    ' example.com',
    'example.com\n',
    'caf\u00e9.example.com',
    '\u212a.example.com',
    `${'a'.repeat(64)}.example.com`,
    `${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`,
  ])('rejects %s', domain => {
    expect(egressAllowlistSchema.safeParse([domain]).success).toBe(false);
  });

  it('limits the submitted list before deduplication', () => {
    expect(egressAllowlistSchema.parse(Array(100).fill('example.com'))).toEqual(['example.com']);
    expect(egressAllowlistSchema.safeParse(Array(101).fill('example.com')).success).toBe(false);
  });
});
