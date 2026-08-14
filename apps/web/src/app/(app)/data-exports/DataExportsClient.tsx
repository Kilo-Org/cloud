'use client';

import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { format } from 'date-fns';
import { AlertCircle, Download, Loader2, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/kiloclaw/instance-display';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import {
  findActiveExport,
  findReadyExport,
  getDisplayStatus,
  getRefetchInterval,
  USER_EXPORT_STATUS_COPY,
  type ExportableOrganization,
  type UserExport,
  type UserExportDisplayStatus,
} from './data-export-contract';
import { DownloadCodeDialog, type DownloadCodeChallenge } from './DownloadCodeDialog';

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
  anchor.download = 'kilo-data-export.jsonl.gz';
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
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const listQueryKey = trpc.userExports.list.queryKey();

  const listQuery = useInfiniteQuery({
    queryKey: listQueryKey,
    queryFn: ({ pageParam }) =>
      trpcClient.userExports.list.query(pageParam ? { cursor: pageParam } : undefined),
    initialPageParam: null as string | null,
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: query => {
      const records = query.state.data?.pages.flatMap(page => page.exports);
      const activeInterval = getRefetchInterval(
        records ? { exports: records, nextCursor: null } : undefined
      );
      if (activeInterval !== false) return activeInterval;
      const now = Date.now();
      const nextExpiry = records
        ?.map(record => (record.status === 'ready' ? record.expiresAt : null))
        .filter((expiresAt): expiresAt is string => expiresAt !== null)
        .map(expiresAt => Date.parse(expiresAt))
        .filter(expiresAt => Number.isFinite(expiresAt) && expiresAt > now)
        .sort((left, right) => left - right)[0];
      return nextExpiry ? Math.min(2_147_483_647, Math.max(1_000, nextExpiry - now)) : false;
    },
  });

  // Empty for anyone who is not an owner or admin somewhere, which is what hides the
  // organization section entirely rather than showing a control that always fails.
  const organizationsQuery = useQuery(trpc.userExports.exportableOrganizations.queryOptions());

  const requestMutation = useMutation(
    trpc.userExports.request.mutationOptions({
      onSuccess: async result => {
        if (result.status === 'ready') {
          toast.info('Your latest export is already ready to download.');
        } else {
          toast.success('Export requested', {
            description: "We'll email you when it's ready to download.",
          });
        }
        await queryClient.resetQueries({ queryKey: listQueryKey });
      },
      onError: error => {
        toast.error('Export request failed', {
          description:
            error.data?.code === 'TOO_MANY_REQUESTS'
              ? error.message
              : 'The export could not be requested. Wait a moment and try again.',
        });
      },
    })
  );

  const requestOrganizationMutation = useMutation(
    trpc.userExports.requestOrganization.mutationOptions({
      onSuccess: async result => {
        if (result.status === 'ready') {
          toast.info('This organization export is already ready to download.');
        } else {
          toast.success('Organization export requested', {
            description: "We'll email you when it's ready to download.",
          });
        }
        await queryClient.resetQueries({ queryKey: listQueryKey });
      },
      onError: error => {
        toast.error('Export request failed', {
          description:
            error.data?.code === 'TOO_MANY_REQUESTS' || error.data?.code === 'UNAUTHORIZED'
              ? error.message
              : 'The export could not be requested. Wait a moment and try again.',
        });
      },
    })
  );

  // Downloading is a two-step step-up: mail a single-use code, then redeem it for
  // one signed URL. A held session alone cannot reach the artifact.
  const [challenge, setChallenge] = useState<DownloadCodeChallenge | null>(null);
  const requestCodeMutation = useMutation(
    trpc.userExports.requestDownloadCode.mutationOptions({
      onSuccess: (result, variables) => {
        setChallenge({
          exportId: variables.exportId,
          challengeId: result.challengeId,
          expiresInMinutes: result.expiresInMinutes,
        });
      },
      onError: error => {
        toast.error('Download code could not be sent', {
          description:
            error.data?.code === 'TOO_MANY_REQUESTS' || error.data?.code === 'PRECONDITION_FAILED'
              ? error.message
              : 'Try again. If the export has expired, request a new one.',
        });
      },
    })
  );

  const exports = listQuery.data?.pages.flatMap(page => page.exports);
  const organizations: ExportableOrganization[] = organizationsQuery.data?.organizations ?? [];
  const personalActiveExport = findActiveExport(exports, null);
  const personalReadyExport = findReadyExport(exports, null);
  const personalActiveCopy = personalActiveExport
    ? USER_EXPORT_STATUS_COPY[getDisplayStatus(personalActiveExport)]
    : null;
  // A ready/downloadable export must not block requesting a new one — only disable
  // while a request is in flight, the list is refetching, or an export is actively
  // generating. The re-request throttle is enforced server-side.
  const requestDisabled =
    requestMutation.isPending || listQuery.isRefetching || Boolean(personalActiveExport);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Request a new export</CardTitle>
          <CardDescription>
            The export includes your App Builder project titles and the prompt prefixes recorded
            with your usage history. Large accounts can take a while to generate. We&apos;ll email
            you when it&apos;s ready, and downloads expire 24 hours after that. Each download needs
            a confirmation code we email you.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-start gap-3">
          <Button
            onClick={() => requestMutation.mutate()}
            disabled={requestDisabled}
            aria-describedby={personalActiveCopy ? 'data-exports-active-hint' : undefined}
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
          {personalActiveCopy && (
            <p id="data-exports-active-hint" className="text-muted-foreground text-sm">
              An export is already {personalActiveCopy.label.toLowerCase()}. You can request another
              export when it finishes.
            </p>
          )}
          {!personalActiveCopy && personalReadyExport && (
            <p className="text-muted-foreground text-sm">
              Your latest export is ready. Download it from Export history below.
            </p>
          )}
        </CardContent>
      </Card>

      {organizations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Organization exports</CardTitle>
            <CardDescription>
              An organization export covers the work its members did in the organization. It does
              not include their personal activity outside it. Only owners and admins can request
              one, and each organization can have one export at a time.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            {organizations.map(organization => (
              <OrganizationExportRow
                key={organization.id}
                organization={organization}
                activeExport={findActiveExport(exports, organization.id)}
                readyExport={findReadyExport(exports, organization.id)}
                isPending={
                  requestOrganizationMutation.isPending &&
                  requestOrganizationMutation.variables?.organizationId === organization.id
                }
                isBusy={requestOrganizationMutation.isPending || listQuery.isRefetching}
                onRequest={() =>
                  requestOrganizationMutation.mutate({ organizationId: organization.id })
                }
              />
            ))}
          </CardContent>
        </Card>
      )}

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
                  isPreparingThisDownload={
                    requestCodeMutation.isPending &&
                    requestCodeMutation.variables?.exportId === record.id
                  }
                  onDownload={() => requestCodeMutation.mutate({ exportId: record.id })}
                />
              ))}
            </ul>
          )}
          {listQuery.hasNextPage && (
            <Button
              className="mt-4"
              variant="outline"
              size="sm"
              onClick={() => void listQuery.fetchNextPage()}
              disabled={listQuery.isFetchingNextPage}
            >
              {listQuery.isFetchingNextPage ? (
                <>
                  <Loader2 className="animate-spin" />
                  Loading more...
                </>
              ) : (
                'Load more'
              )}
            </Button>
          )}
        </CardContent>
      </Card>

      <DownloadCodeDialog
        challenge={challenge}
        isResending={requestCodeMutation.isPending}
        onResend={() => {
          if (challenge) requestCodeMutation.mutate({ exportId: challenge.exportId });
        }}
        onClose={() => setChallenge(null)}
        onVerified={triggerBrowserDownload}
      />
    </div>
  );
}

type OrganizationExportRowProps = {
  organization: ExportableOrganization;
  activeExport: UserExport | undefined;
  readyExport: UserExport | undefined;
  isPending: boolean;
  isBusy: boolean;
  onRequest: () => void;
};

function OrganizationExportRow({
  organization,
  activeExport,
  readyExport,
  isPending,
  isBusy,
  onRequest,
}: OrganizationExportRowProps) {
  const activeCopy = activeExport ? USER_EXPORT_STATUS_COPY[getDisplayStatus(activeExport)] : null;
  const hintId = `data-exports-org-hint-${organization.id}`;
  const hint = activeCopy
    ? `An export is already ${activeCopy.label.toLowerCase()}. Another can be requested when it finishes.`
    : readyExport
      ? 'The latest export is ready. Download it from Export history below.'
      : null;

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        <p className="truncate text-sm font-medium">{organization.name}</p>
        {hint && (
          <p id={hintId} className="text-muted-foreground text-sm">
            {hint}
          </p>
        )}
      </div>
      <Button
        className="shrink-0"
        onClick={onRequest}
        disabled={isBusy || Boolean(activeExport)}
        aria-describedby={hint ? hintId : undefined}
        aria-label={`Request organization export for ${organization.name}`}
      >
        {isPending ? (
          <>
            <Loader2 className="animate-spin" />
            Requesting export...
          </>
        ) : (
          'Request export'
        )}
      </Button>
    </div>
  );
}

type ExportHistoryRowProps = {
  record: UserExport;
  isPreparingThisDownload: boolean;
  onDownload: () => void;
};

function ExportHistoryRow({ record, isPreparingThisDownload, onDownload }: ExportHistoryRowProps) {
  const displayStatus = getDisplayStatus(record);
  const copy = USER_EXPORT_STATUS_COPY[displayStatus];
  const requestedLabel = formatExportTimestamp(record.requestedAt);
  const detailItems = getExportDetailItems(record, displayStatus);

  return (
    <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={STATUS_BADGE_VARIANT[displayStatus]}>{copy.label}</Badge>
          {/* Personal and organization exports share one history list, so each row has
              to say which it is. The name can be null if the organization was deleted
              after the export was requested. */}
          <Badge variant="outline">
            {record.subjectType === 'organization'
              ? (record.organizationName ?? 'Organization')
              : 'Personal'}
          </Badge>
          <span className="text-muted-foreground text-sm">Requested {requestedLabel}</span>
        </div>
        <p role="status" aria-live="polite" className="text-sm">
          {copy.description}
          {displayStatus === 'failed' && record.failureMessage ? ` ${record.failureMessage}` : ''}
        </p>
        {detailItems.length > 0 && (
          <p className="text-muted-foreground text-xs tabular-nums">{detailItems.join(' · ')}</p>
        )}
      </div>
      <div className="shrink-0">
        {(displayStatus === 'ready' || displayStatus === 'expired') && (
          <DownloadExportButton
            isExpired={displayStatus === 'expired'}
            isPreparingThisDownload={isPreparingThisDownload}
            requestedLabel={requestedLabel}
            onDownload={onDownload}
          />
        )}
      </div>
    </li>
  );
}

type DownloadExportButtonProps = {
  isExpired: boolean;
  isPreparingThisDownload: boolean;
  requestedLabel: string;
  onDownload: () => void;
};

function DownloadExportButton({
  isExpired,
  isPreparingThisDownload,
  requestedLabel,
  onDownload,
}: DownloadExportButtonProps) {
  const button = (
    <Button
      size="sm"
      onClick={onDownload}
      disabled={isExpired || isPreparingThisDownload}
      aria-label={
        isExpired
          ? `Download expired for export requested ${requestedLabel}`
          : `Download export requested ${requestedLabel}`
      }
    >
      {isPreparingThisDownload ? (
        <>
          <Loader2 className="animate-spin" />
          Sending code...
        </>
      ) : (
        <>
          <Download />
          Download
        </>
      )}
    </Button>
  );

  if (!isExpired) return button;

  return (
    <Tooltip>
      {/* A disabled button emits no pointer events, so the span wrapper keeps the tooltip hoverable
          and focusable. */}
      <TooltipTrigger asChild>
        <span className="inline-flex" tabIndex={0}>
          {button}
        </span>
      </TooltipTrigger>
      <TooltipContent>Download expired. Request a new export.</TooltipContent>
    </Tooltip>
  );
}
