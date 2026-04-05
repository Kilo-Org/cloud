'use client';

import type { OrganizationRole } from '@/lib/organizations/organization-types';
import { OrganizationPageHeader } from './OrganizationPageHeader';
import { OrganizationContextProvider } from './OrganizationContext';
import { useRoleTesting } from '@/contexts/RoleTestingContext';
import { BYOKKeysManager } from './byok/BYOKKeysManager';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { AlertCircle } from 'lucide-react';

export function BYOKContent({
  organizationId,
  role,
}: {
  organizationId: string;
  role?: OrganizationRole;
}) {
  const { assumedRole } = useRoleTesting();

  // Use assumed role if available, otherwise use actual role
  const currentRole = assumedRole === 'KILO ADMIN' ? 'owner' : assumedRole || role || 'member';
  const isKiloAdmin = assumedRole === 'KILO ADMIN';

  // Check if user has permission to access BYOK (must be org owner)
  const hasPermission = currentRole === 'owner';

  return (
    <OrganizationContextProvider value={{ userRole: currentRole, isKiloAdmin }}>
      <div className="flex w-full flex-col gap-y-4">
        <OrganizationPageHeader
          organizationId={organizationId}
          title="Bring Your Own Key"
          showBackButton={false}
        />
        {!hasPermission ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertTitle>Access Denied</AlertTitle>
            <AlertDescription>
              You must be an organization owner to access BYOK settings.
            </AlertDescription>
          </Alert>
        ) : (
          <BYOKKeysManager organizationId={organizationId} />
        )}
      </div>
    </OrganizationContextProvider>
  );
}
