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
    { egressMode: 'unrestricted' },
    { egressMode: 'allowlist' },
    { egressMode: 'allowlist', egressAllowlist: [] },
    { egressMode: 'allowlist', egressAllowlist: ['example.com'] },
    { egressAudit: false },
    { egressAudit: true },
    { egressMode: 'unrestricted', egressAudit: false },
    { egressMode: 'unrestricted', egressAudit: true },
    { egressMode: 'allowlist', egressAudit: false },
    { egressMode: 'allowlist', egressAudit: true },
  ])('preserves an explicit policy without inferring a mode: %j', policy => {
    expect(egressPolicySchema.parse(policy)).toEqual(policy);
  });

  it.each([
    { egressMode: 'allowlist', egressAudit: null },
    { egressMode: 'allowlist', egressAudit: 'true' },
    { egressMode: 'allowlist', egressAudit: 1 },
  ])('rejects invalid audit opt-ins: %j', policy => {
    const parsed = egressPolicySchema.safeParse(policy);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues).toContainEqual(
        expect.objectContaining({ path: ['egressAudit'] })
      );
    }
  });

  it('normalizes the list when allowlist is explicit', () => {
    expect(
      egressPolicySchema.parse({
        egressMode: 'allowlist',
        egressAllowlist: ['Z.Example.COM.', 'example.com', 'EXAMPLE.COM'],
      })
    ).toEqual({
      egressMode: 'allowlist',
      egressAllowlist: ['example.com', 'z.example.com'],
    });
  });

  it.each([
    { egressAllowlist: [] },
    { egressAllowlist: ['example.com'] },
    { egressMode: 'unrestricted', egressAllowlist: [] },
    { egressMode: 'unrestricted', egressAllowlist: ['example.com'] },
    { egressAllowlist: [], egressAudit: true },
    { egressMode: 'unrestricted', egressAllowlist: ['example.com'], egressAudit: true },
  ])('rejects lists unless allowlist is explicit: %j', policy => {
    const result = egressPolicySchema.safeParse(policy);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toContainEqual(
        expect.objectContaining({ path: ['egressAllowlist'] })
      );
    }
  });

  it.each(['allow-all', 'deny-by-default', 'deny-all', '', null, 0])(
    'rejects unsupported mode %j',
    egressMode => {
      expect(egressModeSchema.safeParse(egressMode).success).toBe(false);
      expect(egressPolicySchema.safeParse({ egressMode }).success).toBe(false);
    }
  );

  it.each(
    [null, ['*'], ['127.1'], ['https://example.com']].map(egressAllowlist => ({ egressAllowlist }))
  )('rejects invalid lists under allowlist: %j', ({ egressAllowlist }) => {
    expect(egressPolicySchema.safeParse({ egressMode: 'allowlist', egressAllowlist }).success).toBe(
      false
    );
  });
});
