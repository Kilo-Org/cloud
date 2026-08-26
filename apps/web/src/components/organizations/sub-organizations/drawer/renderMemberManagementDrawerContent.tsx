import { useEffect } from 'react';
import { usePostHog } from 'posthog-js/react';

import type { DrawerRenderResult, DrawerStackHelpers } from '@/components/drawer';
import { OrganizationAdminContextProvider } from '@/components/organizations/OrganizationContextWrapper';
import { OrganizationAdminMembers } from '@/components/organizations/OrganizationMembersCard';
import type { MemberManagementDrawerEntry, SubOrganizationPeopleData } from './types';
import { AddPeopleWizard } from './wizards/AddPeopleWizard';
import { InvitePersonWizard } from './wizards/InvitePersonWizard';
import { RemovePeopleWizard } from './wizards/RemovePeopleWizard';

/**
 * Fires the drawer-opened telemetry event exactly once per `manage-members`
 * drawer entry. `DrawerStackRenderer` gives every `open()`/`replace()` call
 * a fresh `key`, so this component remounts — and this effect re-runs —
 * once per open, not once per re-render of the drawer contents.
 */
function ManageMembersOpenTracker({
  parentOrganizationId,
  childOrganizationId,
}: {
  parentOrganizationId: string;
  childOrganizationId: string;
}) {
  const posthog = usePostHog();

  useEffect(() => {
    posthog?.capture('sub_org_directory.drawer_opened', {
      parentOrganizationId,
      childOrganizationId,
    });
    // Intentionally run once per mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return null;
}

export function renderMemberManagementDrawerContent(
  parentOrganizationId: string,
  data: SubOrganizationPeopleData,
  entry: MemberManagementDrawerEntry,
  helpers: DrawerStackHelpers<MemberManagementDrawerEntry>
): DrawerRenderResult {
  switch (entry.type) {
    case 'manage-members':
      return {
        header: <h2 className="type-body font-medium">{entry.childOrganizationName}</h2>,
        body: (
          <OrganizationAdminContextProvider organizationId={entry.childOrganizationId}>
            <ManageMembersOpenTracker
              parentOrganizationId={parentOrganizationId}
              childOrganizationId={entry.childOrganizationId}
            />
            <OrganizationAdminMembers organizationId={entry.childOrganizationId} />
          </OrganizationAdminContextProvider>
        ),
      };
    case 'add-people':
      return {
        header: <h2 className="type-body font-medium">Add people to sub-organizations</h2>,
        body: (
          <AddPeopleWizard
            parentOrganizationId={parentOrganizationId}
            people={data.people}
            children={data.children}
            seededIdentityKeys={entry.seededIdentityKeys}
            onClose={helpers.close}
          />
        ),
      };
    case 'remove-people':
      return {
        header: <h2 className="type-body font-medium">Remove people from a sub-organization</h2>,
        body: (
          <RemovePeopleWizard
            parentOrganizationId={parentOrganizationId}
            people={data.people}
            children={data.children}
            seededIdentityKeys={entry.seededIdentityKeys}
            onClose={helpers.close}
          />
        ),
      };
    case 'invite-person':
      return {
        header: <h2 className="type-body font-medium">Invite a new person</h2>,
        body: (
          <InvitePersonWizard parentOrganizationId={parentOrganizationId} onClose={helpers.close} />
        ),
      };
  }
}
