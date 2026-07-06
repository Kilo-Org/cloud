'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { useSidebar, type Sidebar } from '@/components/ui/sidebar';
import { useUrlOrganizationIdentifier } from '@/hooks/useUrlOrganizationId';
import {
  findOrganizationByRouteIdentifier,
  isUuidOrganizationRouteIdentifier,
} from '@/lib/organizations/organization-route-utils';
import { useTRPC } from '@/lib/trpc/utils';
import PersonalAppSidebar from './PersonalAppSidebar';
import OrganizationAppSidebar from './OrganizationAppSidebar';
import { GastownTownSidebar } from '@/components/gastown/GastownTownSidebar';
import { WastelandSidebar } from '@/components/wasteland/WastelandSidebar';

const UUID = '[0-9a-f-]{36}';
const ORG_ROUTE_IDENTIFIER = '[^/]+';

/** Extract the townId from a /gastown/[townId] pathname, or null. */
function extractGastownTownId(pathname: string): string | null {
  const match = pathname.match(new RegExp(`^/gastown/(${UUID})`));
  return match ? match[1] : null;
}

/** Extract {orgIdentifier, townId} from an /organizations/[id]/gastown/[townId] pathname, or null. */
function extractOrgGastownTownId(
  pathname: string
): { orgIdentifier: string; townId: string } | null {
  const match = pathname.match(
    new RegExp(`^/organizations/(${ORG_ROUTE_IDENTIFIER})/gastown/(${UUID})`)
  );
  return match ? { orgIdentifier: decodeURIComponent(match[1]), townId: match[2] } : null;
}

function isKiloClawNewPath(pathname: string): boolean {
  return (
    pathname === '/claw/new' ||
    new RegExp(`^/organizations/${ORG_ROUTE_IDENTIFIER}/claw/new$`).test(pathname)
  );
}

function isOrganizationSetupStep(pathname: string, step: string | null): boolean {
  return (
    new RegExp(`^/organizations/${ORG_ROUTE_IDENTIFIER}/welcome$`).test(pathname) &&
    step !== 'complete'
  );
}

/** Extract the wastelandId from a /wasteland/[wastelandId] pathname, or null. */
function extractWastelandId(pathname: string): string | null {
  const match = pathname.match(new RegExp(`^/wasteland/(${UUID})`));
  return match ? match[1] : null;
}

/** Extract {orgIdentifier, wastelandId} from an /organizations/[id]/wasteland/[wastelandId] pathname, or null. */
function extractOrgWastelandId(
  pathname: string
): { orgIdentifier: string; wastelandId: string } | null {
  const match = pathname.match(
    new RegExp(`^/organizations/(${ORG_ROUTE_IDENTIFIER})/wasteland/(${UUID})`)
  );
  return match ? { orgIdentifier: decodeURIComponent(match[1]), wastelandId: match[2] } : null;
}

export default function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const trpc = useTRPC();
  const currentOrgIdentifier = useUrlOrganizationIdentifier();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const setupStep = searchParams.get('step');
  const { open, setOpenMobile, setOpenTransient } = useSidebar();
  const previousSidebarOpen = useRef<boolean | null>(null);
  const currentSidebarOpen = useRef(open);
  const sidebarActions = useRef({ setOpenMobile, setOpenTransient });
  const { data: organizations = [] } = useQuery(
    trpc.organizations.list.queryOptions(undefined, {
      enabled: Boolean(currentOrgIdentifier),
      trpc: {
        context: {
          skipBatch: true,
        },
      },
    })
  );
  const currentOrgFromList = findOrganizationByRouteIdentifier(
    organizations.map(org => ({
      id: org.organizationId,
      slug: org.organizationSlug,
    })),
    currentOrgIdentifier
  );
  const { data: resolvedCurrentOrg } = useQuery(
    trpc.organizations.resolveRouteIdentifier.queryOptions(
      { routeIdentifier: currentOrgIdentifier ?? '' },
      {
        enabled: Boolean(currentOrgIdentifier && !currentOrgFromList),
        trpc: {
          context: {
            skipBatch: true,
          },
        },
      }
    )
  );
  const currentOrgId =
    currentOrgFromList?.id ??
    resolvedCurrentOrg?.id ??
    (currentOrgIdentifier && isUuidOrganizationRouteIdentifier(currentOrgIdentifier)
      ? currentOrgIdentifier
      : null);

  useEffect(() => {
    currentSidebarOpen.current = open;
  }, [open]);

  useEffect(() => {
    sidebarActions.current = { setOpenMobile, setOpenTransient };
  }, [setOpenMobile, setOpenTransient]);

  useEffect(() => {
    if (isKiloClawNewPath(pathname) || isOrganizationSetupStep(pathname, setupStep)) {
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
  }, [pathname, setupStep]);

  // Personal gastown town — show the town-specific sidebar
  const gastownTownId = extractGastownTownId(pathname);
  if (gastownTownId) {
    return <GastownTownSidebar townId={gastownTownId} {...props} />;
  }

  // Org gastown town — show the same sidebar with org-prefixed paths
  const orgGastown = extractOrgGastownTownId(pathname);
  if (orgGastown) {
    const orgBase = `/organizations/${orgGastown.orgIdentifier}`;
    return (
      <GastownTownSidebar
        townId={orgGastown.townId}
        basePath={`${orgBase}/gastown/${orgGastown.townId}`}
        backHref={`${orgBase}/gastown`}
        {...props}
      />
    );
  }

  // Personal wasteland — show the wasteland-specific sidebar
  const wastelandId = extractWastelandId(pathname);
  if (wastelandId) {
    return <WastelandSidebar wastelandId={wastelandId} {...props} />;
  }

  // Org wasteland — show the same sidebar with org-prefixed paths
  const orgWasteland = extractOrgWastelandId(pathname);
  if (orgWasteland) {
    const orgBase = `/organizations/${orgWasteland.orgIdentifier}`;
    return (
      <WastelandSidebar
        wastelandId={orgWasteland.wastelandId}
        basePath={`${orgBase}/wasteland/${orgWasteland.wastelandId}`}
        backHref={`${orgBase}/wasteland`}
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
