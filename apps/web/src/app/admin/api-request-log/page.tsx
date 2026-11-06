'use client';

import { formatDistanceToNow } from 'date-fns';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useTRPC } from '@/lib/trpc/utils';
import { useAdminPermissions } from '@/app/admin/useAdminPermissions';
import AdminPage from '@/app/admin/components/AdminPage';
import { LogExportForm } from '@/app/admin/components/LogExportForm';
import { BreadcrumbItem } from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { useStepUpActive } from '@/components/admin/step-up/StepUpProvider';

const BYTES_PER_GIGABYTE = 1024 * 1024 * 1024;

export default function ApiRequestLogPage() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const stepUpActive = useStepUpActive();
  const { canExportApiRequestLogs, isPermissionResolved, isError, refetch } = useAdminPermissions();
  const summaryQuery = useQuery(
    trpc.admin.apiRequestLog.getSummary.queryOptions(undefined, {
      enabled: canExportApiRequestLogs,
    })
  );

  async function preflight() {
    if (!stepUpActive) return;
    await queryClient.fetchQuery(
      trpc.admin.apiRequestLog.getSummary.queryOptions(undefined, { staleTime: 0 })
    );
  }

  const breadcrumbs = <BreadcrumbItem className="hidden md:block">API Request Log</BreadcrumbItem>;

  if (isError) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Could not check API request log export access</CardTitle>
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
      </AdminPage>
    );
  }

  if (!isPermissionResolved) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <Card className="max-w-xl">
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            Checking API request log export access...
          </CardContent>
        </Card>
      </AdminPage>
    );
  }

  if (!canExportApiRequestLogs) {
    return (
      <AdminPage breadcrumbs={breadcrumbs}>
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>API request log export access required</CardTitle>
            <CardDescription>
              Ask a superadmin to grant API request log exporter permission on the Admins page.
            </CardDescription>
          </CardHeader>
        </Card>
      </AdminPage>
    );
  }

  return (
    <AdminPage breadcrumbs={breadcrumbs}>
      <div className="w-full max-w-xl space-y-4">
        {summaryQuery.data && (
          <p className="text-muted-foreground text-sm tabular-nums">
            {summaryQuery.data.recordCount.toLocaleString()}{' '}
            {summaryQuery.data.recordCount === 1 ? 'record' : 'records'} ·{' '}
            {(summaryQuery.data.sizeBytes / BYTES_PER_GIGABYTE).toFixed(2)} GB
            {summaryQuery.data.oldestCreatedAt && (
              <>
                {' '}
                · oldest entry{' '}
                <span title={new Date(summaryQuery.data.oldestCreatedAt).toLocaleString()}>
                  {formatDistanceToNow(new Date(summaryQuery.data.oldestCreatedAt), {
                    addSuffix: true,
                  })}
                </span>
              </>
            )}
          </p>
        )}
        <LogExportForm
          title="Download API Request Log"
          downloadPath="/admin/api/api-request-log/download"
          idLabel="Log ID"
          idPlaceholder="Enter numeric log ID"
          idInputMode="numeric"
          showErrorsOnly
          preflight={preflight}
        />
      </div>
    </AdminPage>
  );
}
