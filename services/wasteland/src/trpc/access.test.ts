import { describe, expect, it } from 'vitest';
import { resolveWastelandAccess, type WastelandOwnerFields } from './access';

const viewer = {
  userId: 'user-1',
  isAdmin: false,
  orgMemberships: [{ orgId: 'org-1', role: 'member' }],
};

function owner(overrides: Partial<WastelandOwnerFields> = {}): WastelandOwnerFields {
  return {
    owner_type: 'user',
    owner_user_id: 'user-1',
    organization_id: null,
    ...overrides,
  };
}

describe('resolveWastelandAccess', () => {
  it('grants a user-owned wasteland to its owner', () => {
    expect(resolveWastelandAccess(owner(), viewer)).toEqual({ type: 'user', userId: 'user-1' });
  });

  it('denies another user with forbidden, the surface answer for a wasteland that exists', () => {
    expect(resolveWastelandAccess(owner({ owner_user_id: 'user-2' }), viewer)).toEqual({
      type: 'denied',
      reason: 'forbidden',
    });
  });

  it('grants an org-owned wasteland to a non-billing-manager member', () => {
    expect(
      resolveWastelandAccess(
        owner({ owner_type: 'org', owner_user_id: null, organization_id: 'org-1' }),
        viewer
      )
    ).toEqual({ type: 'org', orgId: 'org-1' });
  });

  it('denies a billing manager', () => {
    expect(
      resolveWastelandAccess(
        owner({ owner_type: 'org', owner_user_id: null, organization_id: 'org-1' }),
        { ...viewer, orgMemberships: [{ orgId: 'org-1', role: 'billing_manager' }] }
      )
    ).toEqual({ type: 'denied', reason: 'forbidden' });
  });

  it('denies a member of another org', () => {
    expect(
      resolveWastelandAccess(
        owner({ owner_type: 'org', owner_user_id: null, organization_id: 'org-2' }),
        viewer
      )
    ).toEqual({ type: 'denied', reason: 'forbidden' });
  });

  it('denies not-found when an org-owned row carries no organization', () => {
    expect(
      resolveWastelandAccess(
        owner({ owner_type: 'org', owner_user_id: null, organization_id: null }),
        viewer
      )
    ).toEqual({ type: 'denied', reason: 'not_found' });
  });

  describe('admin', () => {
    const admin = { ...viewer, userId: 'admin-1', isAdmin: true, orgMemberships: [] };

    it('reaches a wasteland an ordinary user cannot', () => {
      expect(resolveWastelandAccess(owner({ owner_user_id: 'user-2' }), admin)).toEqual({
        type: 'admin',
      });
      expect(
        resolveWastelandAccess(
          owner({ owner_type: 'org', owner_user_id: null, organization_id: 'org-2' }),
          admin
        )
      ).toEqual({ type: 'admin' });
    });

    it('keeps its own identity for a wasteland it owns', () => {
      expect(resolveWastelandAccess(owner({ owner_user_id: 'admin-1' }), admin)).toEqual({
        type: 'user',
        userId: 'admin-1',
      });
    });

    it('reaches a row whose ownership cannot be established', () => {
      expect(
        resolveWastelandAccess(
          owner({ owner_type: 'org', owner_user_id: null, organization_id: null }),
          admin
        )
      ).toEqual({ type: 'admin' });
    });
  });
});
