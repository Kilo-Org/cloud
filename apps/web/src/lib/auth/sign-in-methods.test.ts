import { orderNewAccountProviders, resolveSignInMethods } from './sign-in-methods';

describe('resolveSignInMethods', () => {
  it('filters unsupported and duplicate providers, promoting Google first', () => {
    expect(resolveSignInMethods(['github', 'invalid', 'google', 'github', 'email'])).toEqual({
      kind: 'provider-select',
      providers: ['google', 'github', 'email'],
    });
  });

  it('keeps non-Google provider order stable', () => {
    expect(resolveSignInMethods(['gitlab', 'github', 'email'])).toEqual({
      kind: 'provider-select',
      providers: ['gitlab', 'github', 'email'],
    });
  });

  it('resolves a single OAuth provider automatically', () => {
    expect(resolveSignInMethods(['github'])).toEqual({
      kind: 'automatic-oauth',
      provider: 'github',
    });
  });

  it('resolves email alone automatically', () => {
    expect(resolveSignInMethods(['email'])).toEqual({ kind: 'automatic-email', provider: 'email' });
  });

  it('does not broaden an existing account with no supported methods', () => {
    expect(resolveSignInMethods(['workos', 'fake-login', 'unknown'])).toEqual({
      kind: 'no-supported-method',
    });
  });

  it('orders server-authorized account-creation choices with Google first', () => {
    expect(orderNewAccountProviders(['github', 'email', 'google'])).toEqual([
      'google',
      'github',
      'email',
    ]);
  });
});
