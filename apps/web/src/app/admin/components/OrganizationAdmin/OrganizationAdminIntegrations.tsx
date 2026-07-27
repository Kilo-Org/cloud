'use client';

import { Plug } from 'lucide-react';
import { useAdminOrganizationDetails } from '@/app/admin/api/organizations/hooks';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { PLATFORM_DEFINITIONS } from '@/lib/integrations/platform-definitions';

function getPlatformName(platform: string): string {
  return PLATFORM_DEFINITIONS.find(definition => definition.id === platform)?.name ?? platform;
}

export function OrganizationAdminIntegrations({ organizationId }: { organizationId: string }) {
  const { data, isError } = useAdminOrganizationDetails(organizationId);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Plug className="size-4" />
          Integrations
        </CardTitle>
        <CardDescription>Active integrations owned by this organization.</CardDescription>
      </CardHeader>
      <CardContent>
        {isError ? (
          <p className="type-body text-status-destructive">Unable to load integrations.</p>
        ) : !data ? (
          <div className="flex gap-2" aria-label="Loading integrations">
            <Skeleton className="h-6 w-20 rounded-full" />
            <Skeleton className="h-6 w-16 rounded-full" />
          </div>
        ) : data.integrations.length === 0 ? (
          <p className="type-body text-muted-foreground">No active integrations.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {data.integrations.map(integration => (
              <Badge key={integration.platform} variant="secondary">
                {getPlatformName(integration.platform)}
                {integration.installation_count > 1 && ` (${integration.installation_count})`}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
