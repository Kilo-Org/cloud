'use client';

import { usePathname } from 'next/navigation';
import type { Sidebar } from '@/components/ui/sidebar';
import { useUrlOrganizationId } from '@/hooks/useUrlOrganizationId';
import PersonalAppSidebar from './PersonalAppSidebar';
import OrganizationAppSidebar from './OrganizationAppSidebar';
import { GastownTownSidebar } from '@/components/gastown/GastownTownSidebar';

/** Extract the townId from a /gastown/[townId] pathname, or null. */
function extractGastownTownId(pathname: string): string | null {
  const match = pathname.match(/^\/gastown\/([0-9a-f-]{36})/);
  return match ? match[1] : null;
}

export default function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  const currentOrgId = useUrlOrganizationId();
  const pathname = usePathname();

  // Inside a specific gastown town — show the town-specific sidebar
  const gastownTownId = extractGastownTownId(pathname);
  if (gastownTownId) {
    return <GastownTownSidebar townId={gastownTownId} {...props} />;
  }

  // Render organization sidebar if viewing an organization
  if (currentOrgId) {
    return <OrganizationAppSidebar organizationId={currentOrgId} {...props} />;
  }

  // Otherwise render personal sidebar
  return <PersonalAppSidebar {...props} />;
}
