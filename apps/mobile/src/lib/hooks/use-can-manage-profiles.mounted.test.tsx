import { createElement } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type OrganizationProfilePermission,
  useCanManageOrganizationProfiles,
  useOrganizationProfilePermission,
} from '@/lib/hooks/use-can-manage-profiles';
import { renderWithProviders } from '@/test/render-with-providers';

// The hook's only input is the organization boundary; the membership list
// behind it is covered by its own tests, so only the mapping is under test.
const boundary = vi.hoisted(() => ({
  role: undefined as string | undefined,
  isResolving: false,
}));

vi.mock('@/lib/hooks/use-organization-queries', () => ({
  useOrgBoundary: () => ({ role: boundary.role, isResolving: boundary.isResolving }),
}));

const seen = vi.hoisted(() => ({
  permission: null as OrganizationProfilePermission | null,
  canManage: null as boolean | null,
}));

function PermissionProbe({ organizationId }: Readonly<{ organizationId?: string }>) {
  seen.permission = useOrganizationProfilePermission(organizationId);
  seen.canManage = useCanManageOrganizationProfiles(organizationId);
  return null;
}

async function readPermission(props: Readonly<{ organizationId?: string }>): Promise<{
  permission: OrganizationProfilePermission | null;
  canManage: boolean | null;
}> {
  seen.permission = null;
  seen.canManage = null;
  const { unmount } = await renderWithProviders(createElement(PermissionProbe, props));
  const observed = { permission: seen.permission, canManage: seen.canManage };
  unmount();
  return observed;
}

describe('useOrganizationProfilePermission', () => {
  beforeEach(() => {
    boundary.role = undefined;
    boundary.isResolving = false;
  });

  it('personal scope may create without waiting for a membership', async () => {
    boundary.isResolving = true;
    boundary.role = 'member';

    expect(await readPermission({})).toEqual({ permission: 'allowed', canManage: true });
  });

  it('an unresolved organization reports resolving, not read-only', async () => {
    boundary.isResolving = true;
    boundary.role = 'owner';

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'resolving',
      canManage: false,
    });
  });

  it.each(['owner', 'admin'])('a resolved %s may create', async role => {
    boundary.role = role;

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'allowed',
      canManage: true,
    });
  });

  it('a resolved member may not create', async () => {
    boundary.role = 'member';

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'read-only',
      canManage: false,
    });
  });

  it('a settled boundary with no membership may not create', async () => {
    boundary.role = undefined;

    expect(await readPermission({ organizationId: 'org-1' })).toEqual({
      permission: 'read-only',
      canManage: false,
    });
  });
});
