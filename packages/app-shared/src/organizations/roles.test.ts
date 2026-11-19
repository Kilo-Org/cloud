import { describe, expect, it } from 'vitest';

import {
  canManageOrganization,
  canManageOrganizationBilling,
  canManageOrganizationOwners,
  ORGANIZATION_BILLING_ROLES,
  ORGANIZATION_MANAGE_ROLES,
  ORGANIZATION_PARENT_ACCESS_ROLES,
  ORGANIZATION_ROLE_PRIORITY,
  ORGANIZATION_ROLES,
  ORGANIZATION_SPEND_ALERT_RECIPIENT_ROLES,
} from './roles';

describe('ORGANIZATION_ROLES', () => {
  it('is exactly owner, admin, member, billing_manager', () => {
    expect(ORGANIZATION_ROLES).toEqual(['owner', 'admin', 'member', 'billing_manager']);
  });
});

describe('ORGANIZATION_ROLE_PRIORITY', () => {
  it('ranks owner, admin, billing_manager, member in that order', () => {
    expect(ORGANIZATION_ROLE_PRIORITY).toEqual(['owner', 'admin', 'billing_manager', 'member']);
  });

  it('ranks every canonical role exactly once', () => {
    expect([...ORGANIZATION_ROLE_PRIORITY].sort()).toEqual([...ORGANIZATION_ROLES].sort());
    expect(ORGANIZATION_ROLE_PRIORITY).toHaveLength(ORGANIZATION_ROLES.length);
  });
});

describe('ORGANIZATION_MANAGE_ROLES', () => {
  it('is owner and admin', () => {
    expect(ORGANIZATION_MANAGE_ROLES).toEqual(['owner', 'admin']);
  });
});

describe('ORGANIZATION_PARENT_ACCESS_ROLES', () => {
  it('grants parent inheritance to owner, admin and billing_manager only', () => {
    expect(ORGANIZATION_PARENT_ACCESS_ROLES).toEqual(['owner', 'admin', 'billing_manager']);
  });
});

describe('ORGANIZATION_SPEND_ALERT_RECIPIENT_ROLES', () => {
  it('is owner and billing_manager, narrower than the billing roles', () => {
    expect(ORGANIZATION_SPEND_ALERT_RECIPIENT_ROLES).toEqual(['owner', 'billing_manager']);
    expect(ORGANIZATION_BILLING_ROLES).toContain('admin');
    expect(ORGANIZATION_SPEND_ALERT_RECIPIENT_ROLES).not.toContain('admin');
  });
});

describe('canManageOrganizationBilling', () => {
  it('is true for owner, admin and billing_manager', () => {
    expect(canManageOrganizationBilling('owner')).toBe(true);
    expect(canManageOrganizationBilling('admin')).toBe(true);
    expect(canManageOrganizationBilling('billing_manager')).toBe(true);
  });

  it('is false for member and undefined', () => {
    expect(canManageOrganizationBilling('member')).toBe(false);
    expect(canManageOrganizationBilling(undefined)).toBe(false);
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
