import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type OrganizationProfilePermission,
  useOrganizationProfilePermission,
} from '@/lib/hooks/use-can-manage-profiles';
import { renderWithProviders } from '@/test/render-with-providers';

// The hook's only input is the organization boundary; the membership list
// behind it is covered by its own tests, so only the mapping is under test.
const boundary = vi.hoisted(() => ({
  role: undefined as string | undefined,
  isTrialExpiredForEnforcement: undefined as boolean | undefined,
  isResolving: false,
  isError: false,
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => ({
    role: boundary.role,
    // The membership row is absent while the list has no entry for this
    // organization, and the plan is unknown then.
    org:
      boundary.isTrialExpiredForEnforcement === undefined
        ? undefined
        : { isTrialExpiredForEnforcement: boundary.isTrialExpiredForEnforcement },
    isResolving: boundary.isResolving,
    isError: boundary.isError,
  }),
}));

const seen = vi.hoisted(() => ({
  permission: null as OrganizationProfilePermission | null,
}));

function PermissionProbe({ organizationId }: Readonly<{ organizationId?: string }>) {
  seen.permission = useOrganizationProfilePermission(organizationId);
  return null;
}

async function readPermission(props: Readonly<{ organizationId?: string }>): Promise<{
  permission: OrganizationProfilePermission | null;
}> {
  seen.permission = null;
  const { unmount } = await renderWithProviders(createElement(PermissionProbe, props));
  const observed = { permission: seen.permission };
  unmount();
  return observed;
}

describe('useOrganizationProfilePermission', () => {
  beforeEach(() => {
    boundary.role = undefined;
    boundary.isTrialExpiredForEnforcement = undefined;
    boundary.isResolving = false;
    boundary.isError = false;
  });

  it('personal scope may create without waiting for a membership', async () => {
    boundary.isResolving = true;
    boundary.role = 'member';

    expect(await readPermission({})).toEqual({ permission: 'allowed' });
  });

  it('an unresolved organization reports resolving, not read-only', async () => {
    boundary.isResolving = true;
    boundary.role = 'owner';

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'resolving',
    });
  });

  it.each(['owner', 'admin'])('a resolved %s may create', async role => {
    boundary.role = role;

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'allowed',
    });
  });

  it('a membership list that failed reports resolving, not read-only', async () => {
    boundary.isError = true;
    boundary.role = 'owner';

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'resolving',
    });
  });

  it('a resolved member may not create', async () => {
    boundary.role = 'member';

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'read-only',
    });
  });

  it('a settled boundary with no membership may not create', async () => {
    boundary.role = undefined;

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'read-only',
    });
  });

  it('an owner of an organization whose trial ended reports plan-ended', async () => {
    boundary.role = 'owner';
    boundary.isTrialExpiredForEnforcement = true;

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'plan-ended',
    });
  });

  it('a member of an organization whose trial ended keeps read-only', async () => {
    // The role is the rule this reader can act on: an owner may be asked.
    boundary.role = 'member';
    boundary.isTrialExpiredForEnforcement = true;

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'read-only',
    });
  });

  it('an owner whose role is still resolving reports resolving, not plan-ended', async () => {
    // Neither refusal is safe before the role is known.
    boundary.isResolving = true;
    boundary.role = 'owner';
    boundary.isTrialExpiredForEnforcement = true;

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'resolving',
    });
  });

  it('personal scope may create while the last organization plan ended', async () => {
    boundary.role = 'owner';
    boundary.isTrialExpiredForEnforcement = true;

    expect(await readPermission({})).toEqual({ permission: 'allowed' });
  });

  it('an owner whose organization has a live plan may create', async () => {
    boundary.role = 'owner';
    boundary.isTrialExpiredForEnforcement = false;

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'allowed',
    });
  });

  it('an owner with no membership row may create, because no row is no lapsed plan', async () => {
    boundary.role = 'owner';

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'allowed',
    });
  });
});
