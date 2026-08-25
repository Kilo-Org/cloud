import { validateReturnPath } from './validate-return-path';

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

  it('rejects paths with tabs that URL parsing would treat as an external redirect', () => {
    expect(validateReturnPath('/\t/evil.example/path')).toBeNull();
  });

  it('rejects paths that normalize to a protocol-relative URL', () => {
    expect(validateReturnPath('/..//evil.example/path')).toBeNull();
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

  it('accepts the C13 /cloud/sessions universal-link route', () => {
    expect(validateReturnPath('/cloud/sessions')).toBe('/cloud/sessions');
  });

  it('accepts /cloud/sessions with query params (C13 return-outcome payload)', () => {
    expect(validateReturnPath('/cloud/sessions?github_install=success')).toBe(
      '/cloud/sessions?github_install=success'
    );
  });

  it('accepts /cloud/sessions with error query param', () => {
    expect(validateReturnPath('/cloud/sessions?error=install_state_user_mismatch')).toBe(
      '/cloud/sessions?error=install_state_user_mismatch'
    );
  });

  it('rejects a crafted returnTo that mimics /cloud/ but redirects externally', () => {
    expect(validateReturnPath('/cloud/\nhttps://evil.com')).toBeNull();
  });

  it('rejects triple-slash paths', () => {
    expect(validateReturnPath('///foo')).toBeNull();
  });
});
