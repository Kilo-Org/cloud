'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { AlertCircle, Download, Loader2, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes } from '@/lib/kiloclaw/instance-display';
import { useTRPC } from '@/lib/trpc/utils';
import {
  getDisplayStatus,
  getRefetchInterval,
  isActiveUserExportStatus,
  USER_EXPORT_STATUS_COPY,
  type UserExport,
  type UserExportDisplayStatus,
} from './data-export-contract';

type BadgeVariant = React.ComponentProps<typeof Badge>['variant'];

const STATUS_BADGE_VARIANT: Record<UserExportDisplayStatus, BadgeVariant> = {
  queued: 'secondary',
  processing: 'beta',
  ready: 'new',
  failed: 'destructive',
  expired: 'outline',
};

function formatExportTimestamp(isoTimestamp: string): string {
  return format(new Date(isoTimestamp), 'MMM d, yyyy HH:mm');
}

/** Start a browser download without navigating away from this page. */
function triggerBrowserDownload(url: string) {
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.rel = 'noopener noreferrer';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function getExportDetailItems(record: UserExport, displayStatus: UserExportDisplayStatus) {
  const items: string[] = [];
  if (displayStatus === 'ready' && record.sizeBytes !== null) {
    items.push(`Size ${formatBytes(record.sizeBytes)}`);
  }
  if (record.completedAt && displayStatus !== 'queued' && displayStatus !== 'processing') {
    items.push(`Completed ${formatExportTimestamp(record.completedAt)}`);
  }
  if (displayStatus === 'ready' && record.expiresAt) {
    items.push(`Download available until ${formatExportTimestamp(record.expiresAt)}`);
  }
  if (displayStatus === 'expired' && record.expiresAt) {
    items.push(`Expired ${formatExportTimestamp(record.expiresAt)}`);
  }
  return items;
}

export function DataExportsClient() {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const listQueryKey = trpc.userExports.list.queryKey();

  const listQuery = useQuery(
    trpc.userExports.list.queryOptions(undefined, {
      // Poll only while at least one visible export is queued or processing.
      refetchInterval: query => getRefetchInterval(query.state.data),
    })
  );

  const requestMutation = useMutation(
    trpc.userExports.request.mutationOptions({
      onSuccess: async () => {
        toast.success('Export requested', {
          description: "We'll email you when it's ready to download.",
        });
        await queryClient.invalidateQueries({ queryKey: listQueryKey });
      },
    })
  );

  const downloadMutation = useMutation(
    trpc.userExports.createDownload.mutationOptions({
      onSuccess: result => {
        triggerBrowserDownload(result.downloadUrl);
      },
      onError: () => {
        toast.error('Download could not be started', {
          description: 'Try again. If the export has expired, request a new one.',
        });
      },
    })
  );

  const exports = listQuery.data?.exports;
  const activeExport = exports?.find(record => isActiveUserExportStatus(record.status));
  const activeExportCopy = activeExport
    ? USER_EXPORT_STATUS_COPY[getDisplayStatus(activeExport)]
    : null;
  const requestDisabled = requestMutation.isPending || Boolean(activeExport);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Request a new export</CardTitle>
          <CardDescription>
            The export includes your App Builder project titles and the prompt prefixes recorded
            with your usage history. Large accounts can take a while to generate. We&apos;ll email
            you when it&apos;s ready, and downloads expire 7 days after that.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <Button
            onClick={() => requestMutation.mutate()}
            disabled={requestDisabled}
            aria-describedby={activeExportCopy ? 'data-exports-active-hint' : undefined}
          >
            {requestMutation.isPending ? (
              <>
                <Loader2 className="animate-spin" />
                Requesting export...
              </>
            ) : (
              'Request export'
            )}
          </Button>
          {activeExportCopy && (
            <p id="data-exports-active-hint" className="text-muted-foreground text-sm">
              An export is already {activeExportCopy.label.toLowerCase()}. You can request another
              export when it finishes.
            </p>
          )}
          {requestMutation.isError && (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Export request failed</AlertTitle>
              <AlertDescription>
                The export could not be requested. Wait a moment and try again.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Export history</CardTitle>
          <CardDescription>Your recent data exports.</CardDescription>
        </CardHeader>
        <CardContent>
          {listQuery.isPending ? (
            <div role="status" aria-busy="true" className="flex flex-col gap-4">
              <span className="sr-only">Loading exports...</span>
              {[0, 1, 2].map(index => (
                <div key={index} className="flex flex-col gap-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-full max-w-72" />
                </div>
              ))}
            </div>
          ) : listQuery.isError ? (
            <Alert variant="destructive">
              <AlertCircle />
              <AlertTitle>Exports could not be loaded</AlertTitle>
              <AlertDescription>
                <p>Check your connection and try again.</p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void listQuery.refetch()}
                  disabled={listQuery.isRefetching}
                >
                  {listQuery.isRefetching ? (
                    <>
                      <Loader2 className="animate-spin" />
                      Retrying...
                    </>
                  ) : (
                    <>
                      <RefreshCw />
                      Retry
                    </>
                  )}
                </Button>
              </AlertDescription>
            </Alert>
          ) : !exports || exports.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No exports yet. Request an export to download a copy of your data.
            </p>
          ) : (
            <ul className="divide-border divide-y">
              {exports.map(record => (
                <ExportHistoryRow
                  key={record.id}
                  record={record}
                  isRetrying={requestMutation.isPending}
                  onRetry={() => requestMutation.mutate()}
                  isDownloadPending={downloadMutation.isPending}
                  isPreparingThisDownload={
                    downloadMutation.isPending && downloadMutation.variables?.exportId === record.id
                  }
                  onDownload={() => downloadMutation.mutate({ exportId: record.id })}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

type ExportHistoryRowProps = {
  record: UserExport;
  isRetrying: boolean;
  onRetry: () => void;
  isDownloadPending: boolean;
  isPreparingThisDownload: boolean;
  onDownload: () => void;
};

function ExportHistoryRow({
  record,
  isRetrying,
  onRetry,
  isDownloadPending,
  isPreparingThisDownload,
  onDownload,
}: ExportHistoryRowProps) {
  const displayStatus = getDisplayStatus(record);
  const copy = USER_EXPORT_STATUS_COPY[displayStatus];
  const isActive = displayStatus === 'queued' || displayStatus === 'processing';
  const requestedLabel = formatExportTimestamp(record.requestedAt);
  const detailItems = getExportDetailItems(record, displayStatus);

  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_BADGE_VARIANT[displayStatus]}>{copy.label}</Badge>
          <span className="text-muted-foreground text-sm">Requested {requestedLabel}</span>
        </div>
        <p role={isActive ? 'status' : undefined} className="text-sm">
          {copy.description}
          {displayStatus === 'failed' && record.failureMessage ? ` ${record.failureMessage}` : ''}
        </p>
        {detailItems.length > 0 && (
          <p className="text-muted-foreground text-xs tabular-nums">{detailItems.join(' · ')}</p>
        )}
      </div>
      <div className="shrink-0">
        {displayStatus === 'ready' && (
          <Button
            size="sm"
            onClick={onDownload}
            disabled={isDownloadPending}
            aria-label={`Download export requested ${requestedLabel}`}
          >
            {isPreparingThisDownload ? (
              <>
                <Loader2 className="animate-spin" />
                Preparing download...
              </>
            ) : (
              <>
                <Download />
                Download
              </>
            )}
          </Button>
        )}
        {displayStatus === 'failed' && (
          <Button
            size="sm"
            variant="outline"
            onClick={onRetry}
            disabled={isRetrying}
            aria-label={`Retry the failed export requested ${requestedLabel}`}
          >
            <RefreshCw />
            Retry export
          </Button>
        )}
      </div>
    </li>
  );
}
