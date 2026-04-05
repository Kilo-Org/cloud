import { isValidReturnUrl } from './payment-return-url';

describe('isValidReturnUrl', () => {
  it('should accept valid relative paths', () => {
    expect(isValidReturnUrl('/credits')).toBe(true);
    expect(isValidReturnUrl('/profile')).toBe(true);
    expect(isValidReturnUrl('/organizations/123')).toBe(true);
    expect(isValidReturnUrl('/cloud/sessions')).toBe(true);
    expect(isValidReturnUrl('/app-builder')).toBe(true);
  });

  it('should accept relative paths with query parameters', () => {
    expect(isValidReturnUrl('/credits?foo=bar')).toBe(true);
    expect(isValidReturnUrl('/profile?tab=billing')).toBe(true);
  });

  it('should accept relative paths with hash fragments', () => {
    expect(isValidReturnUrl('/credits#section')).toBe(true);
    expect(isValidReturnUrl('/profile#settings')).toBe(true);
  });

  it('should reject protocol-relative URLs', () => {
    expect(isValidReturnUrl('//evil.com')).toBe(false);
    expect(isValidReturnUrl('//evil.com/path')).toBe(false);
  });

  it('should reject absolute URLs with protocols', () => {
    expect(isValidReturnUrl('http://evil.com')).toBe(false);
    expect(isValidReturnUrl('https://evil.com')).toBe(false);
    expect(isValidReturnUrl('https://example.com/path')).toBe(false);
  });

  it('should reject javascript: URLs', () => {
    expect(isValidReturnUrl('javascript:alert(1)')).toBe(false);
  });

  it('should reject data: URLs', () => {
    expect(isValidReturnUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('should reject empty strings', () => {
    expect(isValidReturnUrl('')).toBe(false);
  });

  it('should reject URLs without leading slash', () => {
    expect(isValidReturnUrl('credits')).toBe(false);
    expect(isValidReturnUrl('profile')).toBe(false);
  });

  it('should reject malformed URLs', () => {
    expect(isValidReturnUrl('not a url')).toBe(false);
    expect(isValidReturnUrl('\\path')).toBe(false);
  });
});
