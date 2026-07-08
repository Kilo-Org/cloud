'use client';

import { useEffect, useRef } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useQuery } from '@tanstack/react-query';
import { Sidebar, useSidebar } from '@/components/ui/sidebar';
import { useUrlOrganizationId } from '@/hooks/useUrlOrganizationId';
import { useUser } from '@/hooks/useUser';
import { useTRPC } from '@/lib/trpc/utils';
import PersonalAppSidebar from './PersonalAppSidebar';
import OrganizationAppSidebar from './OrganizationAppSidebar';
import { GastownTownSidebar } from '@/components/gastown/GastownTownSidebar';
import { WastelandSidebar } from '@/components/wasteland/WastelandSidebar';

const UUID = '[0-9a-f-]{36}';

// Routes linked from the footer user menu (see SidebarUserFooter). Keep in sync.
const FOOTER_MENU_ROUTES = ['/connected-accounts', '/install', '/learn'];

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

function isOrganizationSetupStep(pathname: string, step: string | null): boolean {
  return new RegExp(`^/organizations/${UUID}/welcome$`).test(pathname) && step !== 'complete';
}

/** Extract the wastelandId from a /wasteland/[wastelandId] pathname, or null. */
function extractWastelandId(pathname: string): string | null {
  const match = pathname.match(new RegExp(`^/wasteland/(${UUID})`));
  return match ? match[1] : null;
}

/** Extract {orgId, wastelandId} from an /organizations/[id]/wasteland/[wastelandId] pathname, or null. */
function extractOrgWastelandId(pathname: string): { orgId: string; wastelandId: string } | null {
  const match = pathname.match(new RegExp(`^/organizations/(${UUID})/wasteland/(${UUID})`));
  return match ? { orgId: match[1], wastelandId: match[2] } : null;
}

export default function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const trpc = useTRPC();
  const currentOrgId = useUrlOrganizationId();
  const { data: user } = useUser();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const setupStep = searchParams.get('step');
  const { open, setOpenMobile, setOpenTransient } = useSidebar();
  const personalAccountDisabled = Boolean(user?.personal_account_disabled);
  // Routes we still link to for these users via the footer user menu. On these we
  // keep them in their org sidebar instead of switching to the personal one; other
  // personal routes are not linked but remain accessible with the personal sidebar
  // if reached directly.
  const isFooterMenuRoute = FOOTER_MENU_ROUTES.some(
    route => pathname === route || pathname.startsWith(route + '/')
  );
  const useOrgSidebarForFooterRoute = personalAccountDisabled && !currentOrgId && isFooterMenuRoute;
  const { data: organizations, isPending: isOrganizationsPending } = useQuery(
    trpc.organizations.list.queryOptions(undefined, {
      enabled: useOrgSidebarForFooterRoute,
      trpc: { context: { skipBatch: true } },
    })
  );
  // Match the server-side default (oldest org) so the sidebar org is consistent
  // with getProfileRedirectPath.
  const defaultOrganizationId = organizations?.length
    ? [...organizations].sort((a, b) => {
        const byCreatedAt = a.created_at.localeCompare(b.created_at);
        return byCreatedAt !== 0 ? byCreatedAt : a.organizationId.localeCompare(b.organizationId);
      })[0].organizationId
    : null;
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

  // Personal wasteland — show the wasteland-specific sidebar
  const wastelandId = extractWastelandId(pathname);
  if (wastelandId) {
    return <WastelandSidebar wastelandId={wastelandId} {...props} />;
  }

  // Org wasteland — show the same sidebar with org-prefixed paths
  const orgWasteland = extractOrgWastelandId(pathname);
  if (orgWasteland) {
    const orgBase = `/organizations/${orgWasteland.orgId}`;
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

  // On routes we link to from the footer user menu, keep users with a disabled
  // personal account in their default organization's sidebar rather than the
  // personal one. Any other personal route falls through to the personal sidebar.
  if (useOrgSidebarForFooterRoute) {
    if (defaultOrganizationId) {
      return <OrganizationAppSidebar organizationId={defaultOrganizationId} {...props} />;
    }
    // Avoid flashing the personal sidebar while resolving their default org.
    // Only fall through for the rare case of a user with a disabled personal
    // account who belongs to no organizations.
    if (isOrganizationsPending) {
      return <Sidebar {...props} />;
    }
  }

  // Otherwise render personal sidebar
  return <PersonalAppSidebar {...props} />;
}
