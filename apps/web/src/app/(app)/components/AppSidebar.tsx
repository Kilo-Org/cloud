'use client';

import { useEffect, useRef } from 'react';
import { usePathname } from 'next/navigation';
import { useSidebar, type Sidebar } from '@/components/ui/sidebar';
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

function isKiloClawNewPath(pathname: string): boolean {
  return pathname === '/claw/new' || new RegExp(`^/organizations/${UUID}/claw/new$`).test(pathname);
}

export default function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const currentOrgId = useUrlOrganizationId();
  const pathname = usePathname();
  const { open, setOpenMobile, setOpenTransient } = useSidebar();
  const previousSidebarOpen = useRef<boolean | null>(null);
  const currentSidebarOpen = useRef(open);
  const sidebarActions = useRef({ setOpenMobile, setOpenTransient });

  useEffect(() => {
    currentSidebarOpen.current = open;
  }, [open]);

  useEffect(() => {
    sidebarActions.current = { setOpenMobile, setOpenTransient };
  }, [setOpenMobile, setOpenTransient]);

  useEffect(() => {
    if (isKiloClawNewPath(pathname)) {
      if (previousSidebarOpen.current === null) {
        previousSidebarOpen.current = currentSidebarOpen.current;
      }
      sidebarActions.current.setOpenTransient(false);
      sidebarActions.current.setOpenMobile(false);
      return;
    }

    if (previousSidebarOpen.current !== null) {
      sidebarActions.current.setOpenTransient(previousSidebarOpen.current);
      previousSidebarOpen.current = null;
    }
  }, [pathname]);

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
