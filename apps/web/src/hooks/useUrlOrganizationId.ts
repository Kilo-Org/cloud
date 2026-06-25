import { usePathname } from 'next/navigation';
import { useMemo } from 'react';

const ORG_PATH_REGEX = /^\/organizations\/([^/?#]+)/;

export function getUrlOrganizationIdentifier(pathname: string): string | null {
  const orgMatch = pathname.match(ORG_PATH_REGEX);
  return orgMatch ? decodeURIComponent(orgMatch[1]) : null;
}

/**
 * Hook to extract organization route identifier from the current URL pathname.
 * Returns null if not viewing an organization page.
 *
 * Uses useMemo (not useEffect) so the identifier is available on the first render,
 * avoiding a flash of "Personal Workspace" before the org name appears.
 */
export function useUrlOrganizationIdentifier(): string | null {
  const pathname = usePathname();
  return useMemo(() => {
    return getUrlOrganizationIdentifier(pathname);
  }, [pathname]);
}

export function useUrlOrganizationId(): string | null {
  return useUrlOrganizationIdentifier();
}
