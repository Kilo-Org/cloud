'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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

/**
 * The SSO card needs the organization row the dashboard already loaded, so the
 * shell loads the same read the dashboard uses. Empty, loading, and both
 * failure shapes are spelled out: a shell page has no navigation to fall back
 * on, so a silent spinner would strand the user.
 */
export function AppShellSsoCard({ organizationId, role }: CardProps) {
  const { data, isLoading, error, refetch } = useOrganizationWithMembers(organizationId);

  if (isLoading) return <Skeleton className="h-40 w-full" />;
  if (error) return <CardLoadFailure title="Could not load SSO settings" onRetry={() => refetch()} />;
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

function CardLoadFailure({ title, onRetry }: { title: string; onRetry: () => void }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm">
          The request did not complete. Try again, or close this window and reopen it from the Kilo
          App.
        </p>
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
