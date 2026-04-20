import { resolvePlatformIntegrationOwner } from './resolve-platform-integration-owner';

describe('resolvePlatformIntegrationOwner', () => {
  test('returns org owner when owned_by_organization_id is set', () => {
    const ref = resolvePlatformIntegrationOwner({
      owned_by_organization_id: 'org-1',
      owned_by_user_id: null,
    });
    expect(ref).toEqual({ kind: 'org', id: 'org-1' });
  });

  test('returns user owner when owned_by_user_id is set', () => {
    const ref = resolvePlatformIntegrationOwner({
      owned_by_organization_id: null,
      owned_by_user_id: 'user-1',
    });
    expect(ref).toEqual({ kind: 'user', id: 'user-1' });
  });

  test('prefers organization when both are set (defensive, XOR enforced by schema)', () => {
    const ref = resolvePlatformIntegrationOwner({
      owned_by_organization_id: 'org-1',
      owned_by_user_id: 'user-1',
    });
    expect(ref).toEqual({ kind: 'org', id: 'org-1' });
  });

  test('throws when neither owner is set', () => {
    expect(() =>
      resolvePlatformIntegrationOwner({
        owned_by_organization_id: null,
        owned_by_user_id: null,
      })
    ).toThrow(/Platform integration has no owner/);
  });
});
