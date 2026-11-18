import { describe, expect, it } from '@jest/globals';
import { getLoginMethodDiagnostic, getLoginMethods } from './UserAdminAccountInfo';

describe('getLoginMethods', () => {
  it('shows the name and email associated with each login provider', () => {
    expect(
      getLoginMethods([
        {
          provider: 'anaconda',
          email: 'anaconda@example.com',
          source: 'linked',
          email_relation: 'primary',
        },
        {
          provider: 'github',
          email: 'github@example.com',
          source: 'linked',
          email_relation: 'different',
        },
        {
          provider: 'workos',
          email: 'sso@example.com',
          source: 'linked',
          email_relation: 'conflict',
        },
      ]).map(method => ({ name: method.metadata.name, email: method.email }))
    ).toEqual([
      { name: 'Anaconda', email: 'anaconda@example.com' },
      { name: 'GitHub', email: 'github@example.com' },
      { name: 'Enterprise SSO', email: 'sso@example.com' },
    ]);
  });

  it('shows magic-link email login', () => {
    expect(
      getLoginMethods([
        {
          provider: 'email',
          email: 'user@example.com',
          source: 'inferred',
          email_relation: 'primary',
        },
      ])
    ).toEqual([
      expect.objectContaining({
        metadata: expect.objectContaining({ name: 'Email' }),
        email: 'user@example.com',
        source: 'inferred',
        emailRelation: 'primary',
      }),
    ]);
  });

  it('keeps distinct emails for the same provider visible', () => {
    const longEmail = `${'long-address-'.repeat(8)}@example.com`;
    const methods = getLoginMethods([
      {
        provider: 'github',
        email: 'github@example.com',
        source: 'linked',
        email_relation: 'different',
      },
      {
        provider: 'github',
        email: longEmail,
        source: 'linked',
        email_relation: 'different',
      },
    ]);

    expect(methods.map(method => method.email)).toEqual(['github@example.com', longEmail]);
  });

  it('uses destructive presentation only for cross-account conflicts', () => {
    expect(getLoginMethodDiagnostic('conflict')).toEqual({
      hasConflict: true,
      variant: 'destructive',
      title:
        'This email also resolves to another Kilo account. Email-first discovery will fail closed.',
    });
    expect(getLoginMethodDiagnostic('different')).toEqual({
      hasConflict: false,
      variant: 'secondary',
      title: undefined,
    });
  });
});
