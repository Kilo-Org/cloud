import { describe, expect, it } from 'vitest';

import {
  canManageOrganization,
  canManageOrganizationBilling,
  canManageOrganizationOwners,
  ORGANIZATION_ROLES,
} from './roles';

describe('ORGANIZATION_ROLES', () => {
  it('is exactly owner, admin, member, billing_manager', () => {
    expect(ORGANIZATION_ROLES).toEqual(['owner', 'admin', 'member', 'billing_manager']);
  });
});

describe('canManageOrganizationBilling', () => {
  it('is true for owner, admin and billing_manager', () => {
    expect(canManageOrganizationBilling('owner')).toBe(true);
    expect(canManageOrganizationBilling('admin')).toBe(true);
    expect(canManageOrganizationBilling('billing_manager')).toBe(true);
  });

  it('is false for member, undefined, and unrelated strings', () => {
    expect(canManageOrganizationBilling('member')).toBe(false);
    expect(canManageOrganizationBilling(undefined)).toBe(false);
    expect(canManageOrganizationBilling('kilo_staff')).toBe(false);
  });
});

describe('canManageOrganizationOwners', () => {
  it('is true only for owner', () => {
    expect(canManageOrganizationOwners('owner')).toBe(true);
  });

  it('excludes admin so admins cannot appoint or remove owners', () => {
    expect(canManageOrganizationOwners('admin')).toBe(false);
    expect(canManageOrganizationOwners('billing_manager')).toBe(false);
    expect(canManageOrganizationOwners('member')).toBe(false);
    expect(canManageOrganizationOwners(undefined)).toBe(false);
  });
});

describe('canManageOrganization', () => {
  it('includes owner and admin', () => {
    expect(canManageOrganization('owner')).toBe(true);
    expect(canManageOrganization('admin')).toBe(true);
  });

  it('is false for billing_manager, member and undefined', () => {
    expect(canManageOrganization('billing_manager')).toBe(false);
    expect(canManageOrganization('member')).toBe(false);
    expect(canManageOrganization(undefined)).toBe(false);
  });
});
