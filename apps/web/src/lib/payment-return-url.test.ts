// The cookie store is stubbed so the return URL can round-trip without a request context.
jest.mock('next/headers', () => {
  const store = new Map<string, string>();
  return {
    cookies: async () => ({
      set: (name: string, value: string) => store.set(name, value),
      get: (name: string) => (store.has(name) ? { value: store.get(name) } : undefined),
      delete: (name: string) => store.delete(name),
    }),
  };
});

import {
  getAndClearPaymentReturnUrl,
  getSafeReturnUrlPath,
  setPaymentReturnUrl,
} from './payment-return-url';

function isValid(url: string): boolean {
  return getSafeReturnUrlPath(url) !== null;
}

describe('return URL validation', () => {
  it('should accept valid relative paths', () => {
    expect(isValid('/credits')).toBe(true);
    expect(isValid('/profile')).toBe(true);
    expect(isValid('/organizations/123')).toBe(true);
    expect(isValid('/cloud/sessions')).toBe(true);
  });

  it('should accept relative paths with query parameters', () => {
    expect(isValid('/credits?foo=bar')).toBe(true);
    expect(isValid('/profile?tab=billing')).toBe(true);
  });

  it('should accept relative paths with hash fragments', () => {
    expect(isValid('/credits#section')).toBe(true);
    expect(isValid('/profile#settings')).toBe(true);
  });

  it('should reject protocol-relative URLs', () => {
    expect(isValid('//evil.com')).toBe(false);
    expect(isValid('//evil.com/path')).toBe(false);
  });

  it('should reject absolute URLs with protocols', () => {
    expect(isValid('http://evil.com')).toBe(false);
    expect(isValid('https://evil.com')).toBe(false);
    expect(isValid('https://example.com/path')).toBe(false);
  });

  it('should reject javascript: URLs', () => {
    expect(isValid('javascript:alert(1)')).toBe(false);
  });

  it('should reject data: URLs', () => {
    expect(isValid('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('should reject empty strings', () => {
    expect(isValid('')).toBe(false);
  });

  it('should reject URLs without leading slash', () => {
    expect(isValid('credits')).toBe(false);
    expect(isValid('profile')).toBe(false);
  });

  it('should reject malformed URLs', () => {
    expect(isValid('not a url')).toBe(false);
    expect(isValid('\\path')).toBe(false);
  });

  it('should reject values that resolve to a different origin', () => {
    expect(isValid('/\\evil.com')).toBe(false);
    expect(isValid('/\\\\evil.com')).toBe(false);
    expect(isValid('/\\evil.com/path')).toBe(false);
    expect(isValid('//\\evil.com')).toBe(false);
    expect(isValid('/.//evil.com')).toBe(false);
    expect(isValid('/..//evil.com')).toBe(false);
    expect(isValid('/%2e%2e//evil.com')).toBe(false);
  });

  it('should keep percent-encoded separators as literal path characters', () => {
    expect(getSafeReturnUrlPath('/%5Cevil.com')).toBe('/%5Cevil.com');
  });

  it('should reject non-path characters', () => {
    expect(isValid('/\t')).toBe(false);
    expect(isValid('/\nevil.com')).toBe(false);
    expect(isValid('/credits\u0000')).toBe(false);
    expect(isValid('/credits\u007F')).toBe(false);
  });

  it('should reject URLs with credentials in the URL authority', () => {
    expect(isValid('/\\user@evil.com')).toBe(false);
    expect(isValid('//user:pass@evil.com')).toBe(false);
  });
});

describe('getSafeReturnUrlPath', () => {
  it('should return the path form for internal paths', () => {
    expect(getSafeReturnUrlPath('/credits')).toBe('/credits');
    expect(getSafeReturnUrlPath('/credits?foo=bar')).toBe('/credits?foo=bar');
    expect(getSafeReturnUrlPath('/profile#settings')).toBe('/profile#settings');
    expect(getSafeReturnUrlPath('/credits?a=1#h')).toBe('/credits?a=1#h');
  });

  it('should return null for values outside the application origin', () => {
    expect(getSafeReturnUrlPath('/\\evil.com')).toBeNull();
    expect(getSafeReturnUrlPath('//evil.com')).toBeNull();
    expect(getSafeReturnUrlPath('https://evil.com')).toBeNull();
  });

  it('should return null for values with separators outside the path grammar', () => {
    expect(getSafeReturnUrlPath('/cre\\dits')).toBeNull();
    expect(getSafeReturnUrlPath('/credits\n')).toBeNull();
  });
});

describe('payment return URL cookie', () => {
  it('should store the normalized path', async () => {
    await expect(setPaymentReturnUrl('/credits/../profile?a=1#h')).resolves.toBe(true);

    await expect(getAndClearPaymentReturnUrl()).resolves.toBe('/profile?a=1#h');
  });

  it('should clear the stored path after reading it', async () => {
    await setPaymentReturnUrl('/credits');
    await getAndClearPaymentReturnUrl();

    await expect(getAndClearPaymentReturnUrl()).resolves.toBeNull();
  });

  it('should not store a value outside the application origin', async () => {
    await expect(setPaymentReturnUrl('//evil.com/path')).resolves.toBe(false);

    await expect(getAndClearPaymentReturnUrl()).resolves.toBeNull();
  });
});
