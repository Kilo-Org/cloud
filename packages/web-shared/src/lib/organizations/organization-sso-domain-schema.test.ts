import { OrganizationSSODomainSchema } from './organization-types';

const INVALID_DOMAIN_MESSAGE = 'Please enter a valid domain (e.g. acme.com)';

describe('OrganizationSSODomainSchema', () => {
  it('accepts a bare domain', () => {
    expect(OrganizationSSODomainSchema.parse('acme.com')).toBe('acme.com');
  });

  it('trims and lowercases the input', () => {
    expect(OrganizationSSODomainSchema.parse('  ACME.COM  ')).toBe('acme.com');
  });

  it('accepts a unicode domain and lowercases it', () => {
    expect(OrganizationSSODomainSchema.parse('münchen.de')).toBe('münchen.de');
    expect(OrganizationSSODomainSchema.parse('MÜNCHEN.DE')).toBe('münchen.de');
  });

  it('accepts a punycode TLD domain', () => {
    expect(OrganizationSSODomainSchema.parse('example.xn--p1ai')).toBe('example.xn--p1ai');
  });

  it('rejects a domain without a TLD', () => {
    const result = OrganizationSSODomainSchema.safeParse('acme');
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0].message).toBe(INVALID_DOMAIN_MESSAGE);
  });

  it('rejects a single-character TLD', () => {
    const result = OrganizationSSODomainSchema.safeParse('acme.c');
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0].message).toBe(INVALID_DOMAIN_MESSAGE);
  });

  it('rejects a URL', () => {
    const result = OrganizationSSODomainSchema.safeParse('https://acme.com');
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0].message).toBe(INVALID_DOMAIN_MESSAGE);
  });

  it('rejects blank input', () => {
    const result = OrganizationSSODomainSchema.safeParse('   ');
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0].message).toBe(INVALID_DOMAIN_MESSAGE);
  });
});
