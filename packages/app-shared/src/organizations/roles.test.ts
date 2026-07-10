import { describe, expect, it } from 'vitest';

import { canManageOrganizationBilling, ORGANIZATION_ROLES } from './roles';

describe('ORGANIZATION_ROLES', () => {
  it('is exactly owner, member, billing_manager', () => {
    expect(ORGANIZATION_ROLES).toEqual(['owner', 'member', 'billing_manager']);
  });
});

describe('canManageOrganizationBilling', () => {
  it('is true for owner and billing_manager', () => {
    expect(canManageOrganizationBilling('owner')).toBe(true);
    expect(canManageOrganizationBilling('billing_manager')).toBe(true);
  });

  it('is false for member, undefined, and unrelated strings', () => {
    expect(canManageOrganizationBilling('member')).toBe(false);
    expect(canManageOrganizationBilling(undefined)).toBe(false);
    expect(canManageOrganizationBilling('admin')).toBe(false);
  });
});
