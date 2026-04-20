import { extractEmailDomain } from './email-domain';

describe('extractEmailDomain', () => {
  it('returns the registrable domain for a plain .com address', () => {
    expect(extractEmailDomain('alice@Example.COM')).toBe('example.com');
  });

  it('collapses subdomains to the registrable domain', () => {
    expect(extractEmailDomain('foo@mail.example.com')).toBe('example.com');
    expect(extractEmailDomain('foo@a.b.c.example.com')).toBe('example.com');
  });

  it('handles multi-label public suffixes like .co.uk', () => {
    expect(extractEmailDomain('alice@example.co.uk')).toBe('example.co.uk');
    expect(extractEmailDomain('alice@foo.bar.example.co.uk')).toBe('example.co.uk');
  });

  it('handles other multi-label suffixes', () => {
    expect(extractEmailDomain('alice@foo.example.com.au')).toBe('example.com.au');
    expect(extractEmailDomain('alice@mail.example.ac.uk')).toBe('example.ac.uk');
  });

  it('preserves per-tenant subdomains on private suffixes (allowPrivateDomains)', () => {
    // Without allowPrivateDomains, 'alice.vercel.app' would collapse to 'vercel.app',
    // merging every Vercel-hosted tenant into one bucket. That's useless for
    // admin abuse grouping, so allowPrivateDomains: true is enabled.
    expect(extractEmailDomain('alice@alice.vercel.app')).toBe('alice.vercel.app');
    expect(extractEmailDomain('alice@someone.github.io')).toBe('someone.github.io');
  });

  it('uses the last @ for emails with multiple @ signs', () => {
    expect(extractEmailDomain('weird@foo@example.com')).toBe('example.com');
  });

  it('returns null for input without @', () => {
    expect(extractEmailDomain('no-at-sign')).toBeNull();
  });

  it('returns null for empty domain part', () => {
    expect(extractEmailDomain('trailing@')).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(extractEmailDomain('')).toBeNull();
  });

  it('still returns a sensible domain for unknown TLDs', () => {
    // tldts treats the final label as a public suffix when unknown.
    expect(extractEmailDomain('alice@host.madeuptld')).toBe('host.madeuptld');
    expect(extractEmailDomain('alice@sub.host.madeuptld')).toBe('host.madeuptld');
  });

  it('falls back to `<host>.invalid` when tldts cannot resolve a registrable domain (e.g. IP)', () => {
    expect(extractEmailDomain('alice@192.168.1.1')).toBe('192.168.1.1.invalid');
  });

  it('falls back to `<host>.invalid` for single-label hosts', () => {
    expect(extractEmailDomain('alice@localhost')).toBe('localhost.invalid');
    expect(extractEmailDomain('alice@LOCALHOST')).toBe('localhost.invalid');
  });
});
