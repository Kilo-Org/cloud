'use client';

import { usePathname } from 'next/navigation';
import type { Sidebar } from '@/components/ui/sidebar';
import { useUrlOrganizationId } from '@/hooks/useUrlOrganizationId';
import PersonalAppSidebar from './PersonalAppSidebar';
import OrganizationAppSidebar from './OrganizationAppSidebar';
import { GastownTownSidebar } from '@/components/gastown/GastownTownSidebar';

const UUID = '[0-9a-f-]{36}';

/** Extract the townId from a /gastown/[townId] pathname, or null. */
function extractGastownTownId(pathname: string): string | null {
  const match = pathname.match(new RegExp(`^/gastown/(${UUID})`));
  return match ? match[1] : null;
}

/** Extract {orgId, townId} from an /organizations/[id]/gastown/[townId] pathname, or null. */
function extractOrgGastownTownId(pathname: string): { orgId: string; townId: string } | null {
  const match = pathname.match(new RegExp(`^/organizations/(${UUID})/gastown/(${UUID})`));
  return match ? { orgId: match[1], townId: match[2] } : null;
}

export default function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const currentOrgId = useUrlOrganizationId();
  const pathname = usePathname();

  // Personal gastown town — show the town-specific sidebar
  const gastownTownId = extractGastownTownId(pathname);
  if (gastownTownId) {
    return <GastownTownSidebar townId={gastownTownId} {...props} />;
  }

  // Org gastown town — show the same sidebar with org-prefixed paths
  const orgGastown = extractOrgGastownTownId(pathname);
  if (orgGastown) {
    const orgBase = `/organizations/${orgGastown.orgId}`;
    return (
      <GastownTownSidebar
        townId={orgGastown.townId}
        basePath={`${orgBase}/gastown/${orgGastown.townId}`}
        backHref={`${orgBase}/gastown`}
        {...props}
      />
    );
  }

  // Render organization sidebar if viewing an organization
  if (currentOrgId) {
    return <OrganizationAppSidebar organizationId={currentOrgId} {...props} />;
  }

  // Otherwise render personal sidebar
  return <PersonalAppSidebar {...props} />;
}
