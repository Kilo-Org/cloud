import { usePathname } from 'next/navigation';
import { useMemo } from 'react';

const ORG_PATH_REGEX =
  /^\/organizations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * Hook to extract organization ID from the current URL pathname.
 * Returns null if not viewing an organization page.
 *
 * Uses useMemo (not useEffect) so the org ID is available on the first render,
 * avoiding a flash of "Personal Workspace" before the org name appears.
 */
export function useUrlOrganizationId(): string | null {
  const pathname = usePathname();
  return useMemo(() => {
    const orgMatch = pathname.match(ORG_PATH_REGEX);
    return orgMatch ? orgMatch[1] : null;
  }, [pathname]);
}
