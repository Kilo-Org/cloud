import { describe, expect, it } from '@jest/globals';
import { getLoginMethods } from './UserAdminAccountInfo';

describe('getLoginMethods', () => {
  it('shows the name and email associated with each login provider', () => {
    expect(
      getLoginMethods([
        { provider: 'anaconda', email: 'anaconda@example.com', source: 'linked' },
        { provider: 'github', email: 'github@example.com', source: 'linked' },
        { provider: 'workos', email: 'sso@example.com', source: 'linked' },
      ]).map(method => ({ name: method.metadata.name, email: method.email }))
    ).toEqual([
      { name: 'Anaconda', email: 'anaconda@example.com' },
      { name: 'GitHub', email: 'github@example.com' },
      { name: 'Enterprise SSO', email: 'sso@example.com' },
    ]);
  });

  it('shows magic-link email login', () => {
    expect(
      getLoginMethods([{ provider: 'email', email: 'user@example.com', source: 'inferred' }])
    ).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ name: 'Email' }),
        email: 'user@example.com',
        source: 'inferred',
      }),
    ]);
  });

  it('keeps distinct emails for the same provider visible', () => {
    const longEmail = `${'long-address-'.repeat(8)}@example.com`;
    const methods = getLoginMethods([
      { provider: 'github', email: 'github@example.com', source: 'linked' },
      { provider: 'github', email: longEmail, source: 'linked' },
    ]);

    expect(methods.map(method => method.email)).toEqual(['github@example.com', longEmail]);
  });
});
