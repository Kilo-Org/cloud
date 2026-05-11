import { validateReturnPath, parseStateReturn } from './validate-return-path';

describe('validateReturnPath', () => {
  it('accepts a simple internal path', () => {
    expect(validateReturnPath('/gastown/onboarding')).toBe('/gastown/onboarding');
  });

  it('accepts a path with query params', () => {
    expect(validateReturnPath('/gastown/onboarding?step=repo&orgId=123')).toBe(
      '/gastown/onboarding?step=repo&orgId=123'
    );
  });

  it('rejects protocol-relative URLs', () => {
    expect(validateReturnPath('//evil.com')).toBeNull();
  });

  it('rejects absolute URLs', () => {
    expect(validateReturnPath('https://evil.com')).toBeNull();
  });

  it('rejects backslash-prefixed paths', () => {
    expect(validateReturnPath('/\\evil.com')).toBeNull();
  });

  it('rejects paths with carriage return', () => {
    expect(validateReturnPath('/foo\rbar')).toBeNull();
  });

  it('rejects paths with newline', () => {
    expect(validateReturnPath('/foo\nbar')).toBeNull();
  });

  it('rejects paths without leading slash', () => {
    expect(validateReturnPath('foo/bar')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(validateReturnPath('')).toBeNull();
  });

  it('accepts root path', () => {
    expect(validateReturnPath('/')).toBe('/');
  });

  it('rejects triple-slash paths', () => {
    expect(validateReturnPath('///foo')).toBeNull();
  });
});

describe('parseStateReturn', () => {
  it('parses state with return suffix', () => {
    const encoded = encodeURIComponent('/gastown/onboarding?step=repo');
    const result = parseStateReturn(`user_abc|return=${encoded}`);
    expect(result).toEqual({
      ownerToken: 'user_abc',
      returnTo: '/gastown/onboarding?step=repo',
    });
  });

  it('parses org state with return suffix', () => {
    const encoded = encodeURIComponent('/gastown/onboarding?step=repo&orgId=123');
    const result = parseStateReturn(`org_123|return=${encoded}`);
    expect(result).toEqual({
      ownerToken: 'org_123',
      returnTo: '/gastown/onboarding?step=repo&orgId=123',
    });
  });

  it('parses state without return suffix (backwards compat)', () => {
    const result = parseStateReturn('user_abc');
    expect(result).toEqual({
      ownerToken: 'user_abc',
      returnTo: null,
    });
  });

  it('parses org state without return suffix', () => {
    const result = parseStateReturn('org_123');
    expect(result).toEqual({
      ownerToken: 'org_123',
      returnTo: null,
    });
  });

  it('returns null returnTo when return path is invalid', () => {
    const encoded = encodeURIComponent('//evil.com');
    const result = parseStateReturn(`user_abc|return=${encoded}`);
    expect(result).toEqual({
      ownerToken: 'user_abc',
      returnTo: null,
    });
  });

  it('handles null state', () => {
    const result = parseStateReturn(null);
    expect(result).toEqual({
      ownerToken: '',
      returnTo: null,
    });
  });

  it('returns null returnTo when return suffix has malformed percent-encoding', () => {
    const result = parseStateReturn('user_abc|return=%ZZ');
    expect(result).toEqual({
      ownerToken: 'user_abc',
      returnTo: null,
    });
  });
});
