import { describe, test, expect } from '@jest/globals';
import { isRestrictedPersonalPath, PERSONAL_ACCOUNT_DISABLED_PATH } from '@/lib/personal-account';

describe('isRestrictedPersonalPath', () => {
  test.each(['/profile', '/usage', '/subscriptions', '/invoices', '/credits', '/byok', '/claw'])(
    'blocks personal surface %s',
    pathname => {
      expect(isRestrictedPersonalPath(pathname)).toBe(true);
    }
  );

  test.each([
    '/organizations/11111111-1111-1111-1111-111111111111',
    '/organizations/11111111-1111-1111-1111-111111111111/usage-details',
  ])('allows specific organization route %s', pathname => {
    expect(isRestrictedPersonalPath(pathname)).toBe(false);
  });

  test.each(['/organizations', '/organizations/create', '/organizations/new', '/n'])(
    'blocks the organization index and creation route %s',
    pathname => {
      expect(isRestrictedPersonalPath(pathname)).toBe(true);
    }
  );

  test.each([
    '/connected-accounts',
    '/connected-accounts/github',
    '/install',
    '/install/vscode',
    '/learn',
  ])('allows allowlisted personal route %s', pathname => {
    expect(isRestrictedPersonalPath(pathname)).toBe(false);
  });

  test('allows the error page itself', () => {
    expect(isRestrictedPersonalPath(PERSONAL_ACCOUNT_DISABLED_PATH)).toBe(false);
  });

  test('does not treat a prefix collision as an allowlisted route', () => {
    expect(isRestrictedPersonalPath('/installations')).toBe(true);
  });
});
