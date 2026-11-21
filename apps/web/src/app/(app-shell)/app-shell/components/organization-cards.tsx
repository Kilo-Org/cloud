'use client';

import { CardLoadFailure } from '@/components/CardLoadFailure';
import { Skeleton } from '@/components/ui/skeleton';
import { SSOSignupCard } from '@/components/organizations/SSOSignupCard';
import { OrganizationDataCollectionCard } from '@/components/organizations/OrganizationDataCollectionCard';
import { OrganizationContextProvider } from '@/components/organizations/OrganizationContext';
import { useOrganizationWithMembers } from '@/app/api/organizations/hooks';
import type { OrganizationRole } from '@kilocode/web-shared/lib/organizations/organization-types';

type CardProps = {
  organizationId: string;
  role: OrganizationRole;
};

/** What a reader stranded on a shell page can do about a card that did not load. */
const SHELL_FAILURE_DESCRIPTION =
  'The request did not complete. Try again, or close this window and reopen it from the Kilo App.';

/**
 * The SSO card needs the organization row the dashboard already loaded, so the
 * shell loads the same read the dashboard uses. Empty, loading, and both
 * failure shapes are spelled out: a shell page has no navigation to fall back
 * on, so a silent spinner would strand the user.
 */
export function AppShellSsoCard({ organizationId, role }: CardProps) {
  const { data, isLoading, error, refetch } = useOrganizationWithMembers(organizationId);

  if (error)
    return (
      <CardLoadFailure
        title="Could not load SSO settings"
        description={SHELL_FAILURE_DESCRIPTION}
        onRetry={() => void refetch()}
      />
    );
  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (!data) return <Skeleton className="h-40 w-full" />;

  return (
    <OrganizationContextProvider value={{ userRole: role, isKiloAdmin: false }}>
      <SSOSignupCard organization={data} role={role} shell />
    </OrganizationContextProvider>
  );
}

/** The data-collection card loads the organization itself. */
export function AppShellDataCollectionCard({ organizationId, role }: CardProps) {
  return (
    <OrganizationContextProvider value={{ userRole: role, isKiloAdmin: false }}>
      <OrganizationDataCollectionCard organizationId={organizationId} />
    </OrganizationContextProvider>
  );
}
