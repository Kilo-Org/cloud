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
    <div className="w-full max-w-xl">
      <LogExportForm
        title="Download Provider Metadata"
        description={
          <>
            Exports the AI provider metadata object stored in R2 for each matching{' '}
            <code>microdollar_usage</code> row: the gateway routing decision, Vercel provider
            metadata, and Enkrypt guardrail reports.
          </>
        }
        downloadPath="/admin/api/provider-metadata/download"
        idLabel="Usage ID"
        idPlaceholder="Enter microdollar_usage UUID"
      />
    </div>
  );
}
