import { describe, expect, it } from 'vitest';
import {
  egressAllowlistSchema,
  egressDomainSchema,
  egressModeSchema,
  egressPolicySchema,
} from './egress-allowlist.js';

describe('egressAllowlistSchema', () => {
  it('normalizes, sorts, and deduplicates exact DNS names', () => {
    expect(egressAllowlistSchema.parse(['Z.Example.COM.', 'example.com', 'EXAMPLE.COM.'])).toEqual([
      'example.com',
      'z.example.com',
    ]);
    expect(egressDomainSchema.parse('a-b.123.example')).toBe('a-b.123.example');
  });

  it('accepts empty and omitted lists but rejects null', () => {
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

describe('egressPolicySchema', () => {
  it.each([
    {},
    { egressMode: 'allow-all' },
    { egressMode: 'deny-by-default' },
    { egressMode: 'deny-by-default', egressAllowlist: [] },
    { egressMode: 'deny-by-default', egressAllowlist: ['example.com'] },
  ])('preserves an explicit policy without inferring a mode: %j', policy => {
    expect(egressPolicySchema.parse(policy)).toEqual(policy);
  });

  it('normalizes the list when deny-by-default is explicit', () => {
    expect(
      egressPolicySchema.parse({
        egressMode: 'deny-by-default',
        egressAllowlist: ['Z.Example.COM.', 'example.com', 'EXAMPLE.COM'],
      })
    ).toEqual({
      egressMode: 'deny-by-default',
      egressAllowlist: ['example.com', 'z.example.com'],
    });
  });

  it.each([
    { egressAllowlist: [] },
    { egressAllowlist: ['example.com'] },
    { egressMode: 'allow-all', egressAllowlist: [] },
    { egressMode: 'allow-all', egressAllowlist: ['example.com'] },
  ])('rejects lists unless deny-by-default is explicit: %j', policy => {
    const result = egressPolicySchema.safeParse(policy);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ['egressAllowlist'] })
      );
    }
  });

  it.each(['deny-all', '', null, 0])('rejects unsupported mode %j', egressMode => {
    expect(egressModeSchema.safeParse(egressMode).success).toBe(false);
    expect(egressPolicySchema.safeParse({ egressMode }).success).toBe(false);
  });

  it.each(
    [null, ['*'], ['127.1'], ['https://example.com']].map(egressAllowlist => ({ egressAllowlist }))
  )('rejects invalid lists under deny-by-default: %j', ({ egressAllowlist }) => {
    expect(
      egressPolicySchema.safeParse({ egressMode: 'deny-by-default', egressAllowlist }).success
    ).toBe(false);
  });
});
