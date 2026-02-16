import { normalizeCompanyDomain, isValidDomain, CompanyDomainSchema } from './company-domain';

describe('normalizeCompanyDomain', () => {
  it('returns bare domain as-is', () => {
    expect(normalizeCompanyDomain('acme.com')).toBe('acme.com');
  });

  it('extracts hostname from URL with https', () => {
    expect(normalizeCompanyDomain('https://acme.com')).toBe('acme.com');
  });

  it('extracts hostname from URL with http', () => {
    expect(normalizeCompanyDomain('http://acme.com')).toBe('acme.com');
  });

  it('extracts hostname from URL with path', () => {
    expect(normalizeCompanyDomain('https://acme.com/about')).toBe('acme.com');
  });

  it('extracts hostname from URL with www', () => {
    expect(normalizeCompanyDomain('http://www.acme.com')).toBe('www.acme.com');
  });

  it('extracts hostname from URL with port', () => {
    expect(normalizeCompanyDomain('https://acme.com:8080/path')).toBe('acme.com');
  });

  it('extracts hostname from URL with query string', () => {
    expect(normalizeCompanyDomain('https://acme.com?foo=bar')).toBe('acme.com');
  });

  it('handles bare domain with path by extracting hostname', () => {
    expect(normalizeCompanyDomain('acme.com/about')).toBe('acme.com');
  });

  it('returns null for empty string', () => {
    expect(normalizeCompanyDomain('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(normalizeCompanyDomain('   ')).toBeNull();
  });

  it('trims whitespace from input', () => {
    expect(normalizeCompanyDomain('  acme.com  ')).toBe('acme.com');
  });

  it('handles subdomain', () => {
    expect(normalizeCompanyDomain('sub.acme.com')).toBe('sub.acme.com');
  });
});

describe('isValidDomain', () => {
  it('accepts simple domain', () => {
    expect(isValidDomain('acme.com')).toBe(true);
  });

  it('accepts domain with subdomain', () => {
    expect(isValidDomain('sub.domain.com')).toBe(true);
  });

  it('accepts domain with country code TLD', () => {
    expect(isValidDomain('my-company.co.uk')).toBe(true);
  });

  it('accepts domain with hyphens', () => {
    expect(isValidDomain('my-company.com')).toBe(true);
  });

  it('accepts www subdomain', () => {
    expect(isValidDomain('www.acme.com')).toBe(true);
  });

  it('rejects domain without TLD', () => {
    expect(isValidDomain('acme')).toBe(false);
  });

  it('rejects domain with single-char TLD', () => {
    expect(isValidDomain('acme.c')).toBe(false);
  });

  it('rejects domain starting with hyphen', () => {
    expect(isValidDomain('-acme.com')).toBe(false);
  });

  it('rejects domain ending with hyphen', () => {
    expect(isValidDomain('acme-.com')).toBe(false);
  });

  it('rejects domain with special characters', () => {
    expect(isValidDomain('acme!@#.com')).toBe(false);
  });

  it('rejects domain with spaces', () => {
    expect(isValidDomain('ac me.com')).toBe(false);
  });

  it('rejects domain exceeding 253 characters', () => {
    const longDomain = 'a'.repeat(250) + '.com';
    expect(isValidDomain(longDomain)).toBe(false);
  });

  it('accepts domain at 253 character boundary with valid labels', () => {
    // Build a domain near 253 chars where each label is <= 63 chars
    // 4 labels of 62 chars each + 3 dots + ".com" = 248 + 3 + 4 = 255 — too long
    // Use 3 labels of 62 chars + 2 dots + ".com" = 186 + 2 + 4 = 192 — within limit
    const label = 'a'.repeat(62);
    const maxDomain = `${label}.${label}.${label}.com`;
    expect(isValidDomain(maxDomain)).toBe(true);
  });

  it('rejects domain with a label exceeding 63 characters', () => {
    const longLabel = 'a'.repeat(64);
    expect(isValidDomain(`${longLabel}.com`)).toBe(false);
  });

  it('accepts domain with a label at exactly 63 characters', () => {
    const label63 = 'a'.repeat(63);
    expect(isValidDomain(`${label63}.com`)).toBe(true);
  });
});

describe('CompanyDomainSchema', () => {
  it('normalizes and validates a bare domain', () => {
    const result = CompanyDomainSchema.parse('acme.com');
    expect(result).toBe('acme.com');
  });

  it('normalizes a URL to its domain', () => {
    const result = CompanyDomainSchema.parse('https://acme.com/about');
    expect(result).toBe('acme.com');
  });

  it('returns null for empty string', () => {
    const result = CompanyDomainSchema.parse('');
    expect(result).toBeNull();
  });

  it('returns null for whitespace', () => {
    const result = CompanyDomainSchema.parse('   ');
    expect(result).toBeNull();
  });

  it('rejects invalid domain format', () => {
    const result = CompanyDomainSchema.safeParse('not-a-domain');
    expect(result.success).toBe(false);
  });

  it('rejects domain without TLD after URL normalization', () => {
    const result = CompanyDomainSchema.safeParse('https://localhost');
    expect(result.success).toBe(false);
  });
});
