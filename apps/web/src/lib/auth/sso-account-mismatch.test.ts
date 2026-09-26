import { detectSsoAccountMismatch, normalizeAccountEmail } from './sso-account-mismatch';

describe('normalizeAccountEmail', () => {
  it('trims and lowercases an address', () => {
    expect(normalizeAccountEmail('  A@Example.COM ')).toBe('a@example.com');
  });
});

describe('detectSsoAccountMismatch', () => {
  it('reports both normalised addresses when an SSO request differs from the session', () => {
    expect(
      detectSsoAccountMismatch({ sso: 'true', email: ' A@Example.com ' }, ' B@Example.com ')
    ).toEqual({ expectedEmail: 'a@example.com', signedInEmail: 'b@example.com' });
  });

  it('treats a domain request as an SSO request', () => {
    expect(
      detectSsoAccountMismatch({ domain: 'example.com', email: 'a@example.com' }, 'b@example.com')
    ).toEqual({ expectedEmail: 'a@example.com', signedInEmail: 'b@example.com' });
  });

  it('returns null for a matching address regardless of case or whitespace', () => {
    expect(
      detectSsoAccountMismatch({ sso: 'true', email: ' B@Example.com ' }, 'b@example.com')
    ).toBeNull();
  });

  it('returns null without an SSO flag or domain', () => {
    expect(detectSsoAccountMismatch({ email: 'a@example.com' }, 'b@example.com')).toBeNull();
  });

  it('returns null when the expected email is absent or empty', () => {
    expect(detectSsoAccountMismatch({ sso: 'true' }, 'b@example.com')).toBeNull();
    expect(detectSsoAccountMismatch({ sso: 'true', email: '' }, 'b@example.com')).toBeNull();
    expect(detectSsoAccountMismatch({ sso: 'true', email: '   ' }, 'b@example.com')).toBeNull();
  });

  it('returns null for a signed-out visitor', () => {
    expect(detectSsoAccountMismatch({ sso: 'true', email: 'a@example.com' }, null)).toBeNull();
    expect(detectSsoAccountMismatch({ sso: 'true', email: 'a@example.com' }, undefined)).toBeNull();
    expect(detectSsoAccountMismatch({ sso: 'true', email: 'a@example.com' }, '')).toBeNull();
  });
});
