import { deriveAdminPermissions } from '@/app/admin/useAdminPermissions';

describe('deriveAdminPermissions', () => {
  const permissions = {
    isSuperadmin: true,
    canViewSessions: true,
    canManageCredits: true,
  };

  it('retains successful permission data during a background refetch', () => {
    expect(
      deriveAdminPermissions(true, {
        isSuccess: true,
        isFetching: true,
        data: permissions,
      })
    ).toEqual({
      isPermissionResolved: true,
      isSuperadmin: true,
      canViewSessions: true,
      canManageCredits: true,
    });
  });

  it('fails closed before permission data resolves or when disabled', () => {
    expect(deriveAdminPermissions(true, { isSuccess: false })).toEqual({
      isPermissionResolved: false,
      isSuperadmin: false,
      canViewSessions: false,
      canManageCredits: false,
    });
    expect(
      deriveAdminPermissions(false, {
        isSuccess: true,
        data: permissions,
      })
    ).toEqual({
      isPermissionResolved: false,
      isSuperadmin: false,
      canViewSessions: false,
      canManageCredits: false,
    });
  });
});
