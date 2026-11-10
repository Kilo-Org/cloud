'use client';

import { useAdminPermissions } from '@/app/admin/useAdminPermissions';
import { LogExportForm } from '@/app/admin/components/LogExportForm';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function ProviderMetadataContent() {
  const { canExportApiRequestLogs, isPermissionResolved, isError, refetch } = useAdminPermissions();

  if (isError) {
    return (
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle>Could not check provider metadata export access</CardTitle>
          <CardDescription>The permission check request failed.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button
            variant="outline"
            onClick={() => {
              void refetch();
            }}
          >
            Retry
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (!isPermissionResolved) {
    return (
      <Card className="w-full max-w-xl">
        <CardContent className="text-muted-foreground py-8 text-center text-sm">
          Checking provider metadata export access...
        </CardContent>
      </Card>
    );
  }

  if (!canExportApiRequestLogs) {
    return (
      <Card className="w-full max-w-xl">
        <CardHeader>
          <CardTitle>Provider metadata export access required</CardTitle>
          <CardDescription>
            Ask a superadmin to grant API request log exporter permission on the Admins page.
          </CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="w-full max-w-3xl">
      <LogExportForm
        title="Download Provider Metadata"
        description={
          <>
            The routing decision, Vercel provider metadata, and Enkrypt input and output guardrail
            reports stored for each matching usage record.
          </>
        }
        downloadPath="/admin/api/provider-metadata/download"
        idLabel="Usage ID"
        idPlaceholder="Enter usage UUID"
      />
    </div>
  );
}
