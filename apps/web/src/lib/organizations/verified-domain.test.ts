import { canonicalizeEligibleVerifiedDomain } from './verified-domain';

describe('canonicalizeEligibleVerifiedDomain', () => {
  it.each([
    [' Example.COM ', 'example.com'],
    ['team.example.com', 'team.example.com'],
    ['münchen.de', 'xn--mnchen-3ya.de'],
    ['例え.jp', 'xn--r8jz45g.jp'],
  ])('canonicalizes %s', (input, expected) => {
    expect(canonicalizeEligibleVerifiedDomain(input)).toBe(expected);
  });

  it.each([
    '',
    'localhost',
    'https://example.com',
    'user@example.com',
    'example.com/path',
    'example.com?query=1',
    'example.com:443',
    'example.com.',
    'example.com\0',
    'example.com\x01',
    '-example.com',
    'example-.com',
    'example..com',
    'example_com',
    '127.0.0.1',
    'com',
    'co.uk',
    `${'a'.repeat(64)}.com`,
    `${'a'.repeat(250)}.com`,
  ])('rejects invalid claim input %s', input => {
    expect(canonicalizeEligibleVerifiedDomain(input)).toBeNull();
  });

  it('accepts a label at the DNS length limit', () => {
    const domain = `${'a'.repeat(63)}.com`;
    expect(canonicalizeEligibleVerifiedDomain(domain)).toBe(domain);
  });

  it.each(['gmail.com', 'GOOGLEMAIL.COM', 'outlook.com', 'yahoo.com', 'proton.me'])(
    'rejects public consumer email domain %s',
    input => {
      expect(canonicalizeEligibleVerifiedDomain(input)).toBeNull();
    }
  );

  it('does not reject an organizational subdomain by suffix', () => {
    expect(canonicalizeEligibleVerifiedDomain('engineering.example.com')).toBe(
      'engineering.example.com'
    );
  });
});
