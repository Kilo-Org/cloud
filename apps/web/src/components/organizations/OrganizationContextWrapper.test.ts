import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  OrganizationRole,
  OrganizationWithMembersResponse,
} from '@kilocode/web-shared/lib/organizations/organization-types';
import {
  canManageOrganization,
  canManageOrganizationBilling,
} from '@kilocode/app-shared/organizations';
import {
  useIsAutoTopUpEnabled,
  useIsKiloAdmin,
  useUserOrganizationRole,
} from './OrganizationContext';
import type { OrganizationAdminContextProvider as OrganizationAdminContextProviderComponent } from './OrganizationContextWrapper';
import type { OrganizationTrialWrapper as OrganizationTrialWrapperComponent } from './OrganizationTrialWrapper';

jest.mock('@/contexts/RoleTestingContext', () => ({
  useRoleTesting: () => ({ assumedRole: mockAssumedRole }),
}));

jest.mock('next-auth/react', () => ({
  useSession: () => ({ data: { isAdmin: mockIsKiloAdmin, user: { email: 'parent@example.com' } } }),
}));

jest.mock('@/app/api/organizations/hooks', () => ({
  useOrganizationWithMembers: () => ({ data: mockOrganization }),
  useOrganizationTrialStatus: () => 'trial_ending_soon',
}));

jest.mock('next/navigation', () => ({
  usePathname: () => '/organizations/child',
}));

jest.mock('./FreeTrialWarningDialog', () => ({ FreeTrialWarningDialog: () => null }));
jest.mock('./UpgradeTrialDialog', () => ({ UpgradeTrialDialog: () => null }));

let mockAssumedRole: OrganizationRole | 'KILO ADMIN' | null = null;
let mockIsKiloAdmin = false;

const mockOrganization = {
  id: 'child',
  name: 'Child organization',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  microdollars_used: 0,
  total_microdollars_acquired: 0,
  next_credit_expiration_at: null,
  stripe_customer_id: null,
  auto_top_up_enabled: false,
  settings: {},
  seat_count: 0,
  require_seats: false,
  created_by_kilo_user_id: null,
  deleted_at: null,
  sso_domain: null,
  parent_organization_id: 'parent',
  plan: 'teams',
  free_trial_end_at: '2099-01-01T00:00:00.000Z',
  company_domain: null,
  callerRole: 'owner',
  members: [],
  childOrganizations: [],
  effectiveSsoPolicy: { required: false, source: null, domain: null, configurationError: false },
} satisfies OrganizationWithMembersResponse;

const previousReact = Reflect.get(globalThis, 'React');
let OrganizationAdminContextProvider: typeof OrganizationAdminContextProviderComponent;
let OrganizationTrialWrapper: typeof OrganizationTrialWrapperComponent;

beforeAll(async () => {
  Object.assign(globalThis, { React });
  ({ OrganizationAdminContextProvider } = await import('./OrganizationContextWrapper'));
  ({ OrganizationTrialWrapper } = await import('./OrganizationTrialWrapper'));
});

afterAll(() => {
  if (previousReact === undefined) Reflect.deleteProperty(globalThis, 'React');
  else Reflect.set(globalThis, 'React', previousReact);
});

beforeEach(() => {
  mockAssumedRole = null;
  mockIsKiloAdmin = false;
});

function Permissions() {
  const role = useUserOrganizationRole();
  return createElement('output', {
    'data-role': role,
    'data-manage-members': canManageOrganization(role),
    'data-manage-billing': canManageOrganizationBilling(role),
    'data-kilo-admin': useIsKiloAdmin(),
    'data-auto-top-up': useIsAutoTopUpEnabled(),
  });
}

function renderPermissions(role: OrganizationRole) {
  return renderToStaticMarkup(
    createElement(OrganizationAdminContextProvider, {
      role,
      isAutoTopUpEnabled: true,
      children: createElement(Permissions),
    })
  );
}

function renderTrial(role: OrganizationRole) {
  return renderToStaticMarkup(
    createElement(OrganizationTrialWrapper, {
      organizationId: mockOrganization.id,
      role,
      children: createElement('div', null, 'Organization content'),
    })
  );
}

describe('OrganizationAdminContextProvider effective roles', () => {
  it.each([
    { role: 'owner', manageMembers: true, manageBilling: true },
    { role: 'admin', manageMembers: true, manageBilling: true },
    { role: 'billing_manager', manageMembers: false, manageBilling: true },
    { role: 'member', manageMembers: false, manageBilling: false },
  ] as const)(
    'uses the authorized $role role without a direct child membership',
    ({ role, manageMembers, manageBilling }) => {
      const html = renderPermissions(role);

      expect(html).toContain(`data-role="${role}"`);
      expect(html).toContain(`data-manage-members="${manageMembers}"`);
      expect(html).toContain(`data-manage-billing="${manageBilling}"`);
      expect(html).toContain('data-kilo-admin="false"');
      expect(html).toContain('data-auto-top-up="true"');
    }
  );

  it('preserves assumed roles for role testing', () => {
    mockAssumedRole = 'member';
    const html = renderPermissions('owner');

    expect(html).toContain('data-role="member"');
    expect(html).toContain('data-manage-members="false"');
    expect(html).toContain('data-manage-billing="false"');
  });

  it('preserves the Kilo admin testing override', () => {
    mockAssumedRole = 'KILO ADMIN';
    const html = renderPermissions('member');

    expect(html).toContain('data-role="owner"');
    expect(html).toContain('data-kilo-admin="true"');
  });

  it('preserves Kilo staff status from the session', () => {
    mockIsKiloAdmin = true;

    expect(renderPermissions('owner')).toContain('data-kilo-admin="true"');
  });
});

describe('OrganizationTrialWrapper effective roles', () => {
  it.each(['owner', 'admin'] as const)(
    'offers the upgrade action to an inherited %s without a direct child membership',
    role => {
      const html = renderTrial(role);

      expect(html).toContain('Upgrade Now');
      expect(html).toContain('Organization content');
      expect(html).not.toContain('Contact an owner');
    }
  );

  it.each(['member', 'billing_manager'] as const)(
    'does not grant the upgrade action to a %s',
    role => {
      const html = renderTrial(role);

      expect(html).not.toContain('Upgrade Now');
      expect(html).toContain('Contact an owner');
    }
  );

  it('preserves the assumed member role on trial pages', () => {
    mockAssumedRole = 'member';

    expect(renderTrial('owner')).not.toContain('Upgrade Now');
  });
});
