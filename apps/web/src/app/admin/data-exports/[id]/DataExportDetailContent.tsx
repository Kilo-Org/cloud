'use client';

import { useQuery } from '@tanstack/react-query';
import { AlertCircle, AlertTriangle, RefreshCw } from 'lucide-react';
import Link from 'next/link';

import { useTRPC } from '@/lib/trpc/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import type { DataExportDetail } from '../data-export-types';
import { DataExportRecoveryCard } from './DataExportRecoveryCard';
import {
  booleanBadgeClass,
  emailStatusBadgeClass,
  formatBytes,
  formatCount,
  formatTimestamp,
  humanizeToken,
  severityBadgeClass,
  severityLabel,
  statusBadgeClass,
} from '../data-export-format';

function shortId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

function DetailField({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-start justify-between gap-4 py-1.5', className)}>
      <dt className="text-muted-foreground shrink-0 text-sm">{label}</dt>
      <dd className="text-right text-sm break-words">{children}</dd>
    </div>
  );
}

function BooleanValue({ value }: { value: boolean }) {
  return (
    <Badge variant="outline" className={booleanBadgeClass(value)}>
      {value ? 'Yes' : 'No'}
    </Badge>
  );
}

function TimestampValue({ value }: { value: string | null }) {
  if (!value) return <span className="text-muted-foreground">Not available</span>;
  return <span className="whitespace-nowrap">{formatTimestamp(value)}</span>;
}

function automaticWorkItems(detail: DataExportDetail): Array<{ label: string; value: boolean }> {
  const work = detail.health.automaticWork;
  return [
    { label: 'Worker claim', value: work.workerClaim },
    { label: 'Reconcile to queued', value: work.reconcileToQueued },
    { label: 'Reconcile to failed', value: work.reconcileToFailed },
    { label: 'Dispatch current outbox entry', value: work.dispatchCurrentOutbox },
    { label: 'Expire ready object', value: work.expireReadyObject },
    { label: 'Abort failed multipart upload', value: work.abortFailedMultipart },
    { label: 'Send or reclaim email', value: work.sendOrReclaimEmail },
    { label: 'Download available to user', value: work.downloadAvailable },
  ];
}

function ExportIdentityCard({ detail }: { detail: DataExportDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Export identity</CardTitle>
        <CardDescription>Data subject, requester, and current lifecycle status.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border">
          <DetailField label="Export ID">
            <span className="font-mono text-xs break-all">{detail.id}</span>
          </DetailField>
          <DetailField label="Subject type">
            <Badge variant="outline">
              {detail.subject.type === 'organization' ? 'Organization' : 'Personal'}
            </Badge>
          </DetailField>
          {detail.subject.organization ? (
            <>
              <DetailField label="Organization">
                <Link
                  className="text-link hover:text-link-hover rounded-sm underline decoration-current/40 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  href={`/admin/organizations/${encodeURIComponent(detail.subject.organization.id)}`}
                >
                  {detail.subject.organization.name ?? detail.subject.organization.id}
                </Link>
              </DetailField>
              <DetailField label="Organization ID">
                <span className="font-mono text-xs break-all">
                  {detail.subject.organization.id}
                </span>
              </DetailField>
            </>
          ) : (
            <DetailField label="Data subject">Requester's own account</DetailField>
          )}
          <DetailField label="Requested by">
            <Link
              className="text-link hover:text-link-hover rounded-sm underline decoration-current/40 underline-offset-4 outline-none focus-visible:ring-2 focus-visible:ring-ring"
              href={`/admin/users/${encodeURIComponent(detail.user.id)}`}
            >
              {detail.user.email}
            </Link>
          </DetailField>
          <DetailField label="Requester name">{detail.user.name ?? 'Not available'}</DetailField>
          <DetailField label="Requester ID">
            <span className="font-mono text-xs break-all">{detail.user.id}</span>
          </DetailField>
          <DetailField label="Status">
            <Badge variant="outline" className={statusBadgeClass(detail.status)}>
              {humanizeToken(detail.status)}
            </Badge>
          </DetailField>
          <DetailField label="Schema version">
            <span className="tabular-nums">{detail.schemaVersion}</span>
          </DetailField>
        </dl>
      </CardContent>
    </Card>
  );
}

function LifecycleCard({ detail }: { detail: DataExportDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Lifecycle</CardTitle>
        <CardDescription>Request-to-completion timestamps for this export.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border">
          <DetailField label="Requested">
            <TimestampValue value={detail.requestedAt} />
          </DetailField>
          <DetailField label="Started">
            <TimestampValue value={detail.startedAt} />
          </DetailField>
          <DetailField label="Completed">
            <TimestampValue value={detail.completedAt} />
          </DetailField>
          <DetailField label="Expires">
            <TimestampValue value={detail.expiresAt} />
          </DetailField>
          <DetailField label="Snapshot">
            <TimestampValue value={detail.snapshotAt} />
          </DetailField>
          <DetailField label="Last updated">
            <TimestampValue value={detail.updatedAt} />
          </DetailField>
        </dl>
      </CardContent>
    </Card>
  );
}

function ProcessingCard({ detail }: { detail: DataExportDetail }) {
  const leaseRecoveryDue =
    detail.health.execution === 'lease_recovery_due' ||
    detail.health.execution === 'lease_attempts_exhausted';
  return (
    <Card>
      <CardHeader>
        <CardTitle>Processing</CardTitle>
        <CardDescription>
          One-shot worker attempt, dispatch generation, and lease state.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border">
          <DetailField label="Legacy source state">
            <BooleanValue
              value={
                detail.currentSource !== null ||
                detail.hasSourceCursor ||
                detail.nextPartNumber !== 1
              }
            />
          </DetailField>
          <DetailField label="Dispatch generation">
            <span className="tabular-nums">{detail.dispatchGeneration}</span>
          </DetailField>
          <DetailField label="Attempts">
            <span className="tabular-nums">{formatCount(detail.attemptCount)}</span>
          </DetailField>
          <DetailField label="Lease expires">
            <span>
              <TimestampValue value={detail.leaseExpiresAt} />
              {leaseRecoveryDue ? (
                <span className="text-destructive block text-xs">Lease expired</span>
              ) : null}
            </span>
          </DetailField>
          <DetailField label="Rows exported">
            <span className="tabular-nums">{formatCount(detail.rowCount)}</span>
          </DetailField>
          <DetailField label="Size">{formatBytes(detail.sizeBytes)}</DetailField>
        </dl>
      </CardContent>
    </Card>
  );
}

function HealthCard({ detail }: { detail: DataExportDetail }) {
  const { health } = detail;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Health</CardTitle>
        <CardDescription>
          Classified execution, dispatch, and email signals with the reasons behind them.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <dl className="divide-y divide-border">
          <DetailField label="Severity">
            <Badge variant="outline" className={severityBadgeClass(health.severity)}>
              {severityLabel(health.severity)}
            </Badge>
          </DetailField>
          <DetailField label="Execution">{humanizeToken(health.execution)}</DetailField>
          <DetailField label="Dispatch">{humanizeToken(health.dispatch)}</DetailField>
          <DetailField label="Email">{humanizeToken(health.email)}</DetailField>
        </dl>
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-sm">Health reasons</p>
          {health.reasons.length === 0 ? (
            <p className="text-muted-foreground text-sm">No outstanding reasons.</p>
          ) : (
            <div className="flex flex-wrap gap-1">
              {health.reasons.map(reason => (
                <Badge
                  key={reason}
                  variant="outline"
                  className="border-status-warning-border bg-status-warning-surface text-status-warning"
                >
                  {humanizeToken(reason)}
                </Badge>
              ))}
            </div>
          )}
        </div>
        {detail.integrityWarnings.length > 0 ? (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-sm">Integrity warnings</p>
            <div className="flex flex-wrap gap-1">
              {detail.integrityWarnings.map(warning => (
                <Badge
                  key={warning}
                  variant="outline"
                  className="border-destructive/30 bg-destructive/10 text-destructive"
                >
                  <AlertTriangle className="size-3" />
                  {humanizeToken(warning)}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function AutomaticWorkCard({ detail }: { detail: DataExportDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Automatic work eligibility</CardTitle>
        <CardDescription>
          Background workers and reconcilers perform the eligible work below automatically. Use
          manual intervention only when automatic recovery is not making progress.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border">
          {automaticWorkItems(detail).map(item => (
            <DetailField key={item.label} label={item.label}>
              <BooleanValue value={item.value} />
            </DetailField>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function ArtifactCard({ detail }: { detail: DataExportDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Artifact</CardTitle>
        <CardDescription>Stored export object, upload state, and retention.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border">
          <DetailField label="Stored object">
            <BooleanValue value={detail.hasR2Object} />
          </DetailField>
          <DetailField label="Multipart upload open">
            <BooleanValue value={detail.hasMultipartUpload} />
          </DetailField>
          <DetailField label="Size">{formatBytes(detail.sizeBytes)}</DetailField>
          <DetailField label="Expires">
            <TimestampValue value={detail.expiresAt} />
          </DetailField>
        </dl>
      </CardContent>
    </Card>
  );
}

function NotificationCard({ detail }: { detail: DataExportDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Notification</CardTitle>
        <CardDescription>Download email delivery state for this export.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border">
          <DetailField label="Email status">
            <Badge variant="outline" className={emailStatusBadgeClass(detail.emailStatus)}>
              {humanizeToken(detail.emailStatus)}
            </Badge>
          </DetailField>
          <DetailField label="Email attempts">
            <span className="tabular-nums">{formatCount(detail.emailAttemptCount)}</span>
          </DetailField>
          <DetailField label="Email lease expires">
            <TimestampValue value={detail.emailLeaseExpiresAt} />
          </DetailField>
          <DetailField label="Email sent">
            <TimestampValue value={detail.emailSentAt} />
          </DetailField>
        </dl>
      </CardContent>
    </Card>
  );
}

function FailureCard({ detail }: { detail: DataExportDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Failure</CardTitle>
        <CardDescription>Recorded failure information for this export.</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border">
          <DetailField label="Failure code">
            <span className="font-mono text-xs">{detail.failureCode ?? 'Not available'}</span>
          </DetailField>
          <DetailField label="Failure message" className="flex-col items-stretch gap-1">
            <span className="text-left whitespace-pre-wrap">
              {detail.failureMessage ?? 'Not available'}
            </span>
          </DetailField>
        </dl>
      </CardContent>
    </Card>
  );
}

function PartsCard({ detail }: { detail: DataExportDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Legacy persisted parts</CardTitle>
        <CardDescription>
          One-shot exports keep multipart parts only in memory. Any rows here are retired generator
          state and are discarded by redispatch.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="divide-y divide-border">
          <DetailField label="Parts">
            <span className="tabular-nums">{formatCount(detail.parts.count)}</span>
          </DetailField>
          <DetailField label="Legacy persisted size">
            {formatBytes(detail.parts.checkpointSizeBytes)}
          </DetailField>
          <DetailField label="First part">
            <span className="tabular-nums">{detail.parts.firstPartNumber ?? 'Not available'}</span>
          </DetailField>
          <DetailField label="Last part">
            <span className="tabular-nums">{detail.parts.lastPartNumber ?? 'Not available'}</span>
          </DetailField>
        </dl>
      </CardContent>
    </Card>
  );
}

function OutboxHistoryCard({ detail }: { detail: DataExportDetail }) {
  const { outbox } = detail;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Outbox history</CardTitle>
        <CardDescription>
          {formatCount(outbox.generations)} dispatch generation
          {outbox.generations === 1 ? '' : 's'}, {formatCount(outbox.pendingGenerations)} pending.
          Newest generations first.
          {outbox.generations > outbox.items.length
            ? ` Showing the latest ${outbox.items.length}.`
            : ''}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {outbox.items.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No outbox entries exist for this export. An active export without an outbox entry is
            reported as a health reason above.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Generation</TableHead>
                  <TableHead>Operation</TableHead>
                  <TableHead>Attempts</TableHead>
                  <TableHead>Available</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {outbox.items.map(item => (
                  <TableRow key={item.id}>
                    <TableCell className="text-sm">
                      <div className="flex items-center gap-2">
                        <span className="tabular-nums">{item.generation}</span>
                        {item.isCurrentGeneration ? (
                          <Badge
                            variant="outline"
                            className="border-status-info-border bg-status-info-surface text-status-info"
                          >
                            Current
                          </Badge>
                        ) : null}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{humanizeToken(item.operation)}</TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {formatCount(item.attemptCount)}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {formatTimestamp(item.availableAt)}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {item.sentAt ? (
                        formatTimestamp(item.sentAt)
                      ) : (
                        <span className="text-muted-foreground">Not sent</span>
                      )}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {formatTimestamp(item.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm whitespace-nowrap">
                      {formatTimestamp(item.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <div className="flex w-full flex-col gap-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-56 w-full rounded-xl" />
        ))}
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
    </div>
  );
}

export function DataExportDetailContent({ exportId }: { exportId: string }) {
  const trpc = useTRPC();
  const detailQuery = useQuery(trpc.admin.userDataExports.detail.queryOptions({ exportId }));
  const detail = detailQuery.data;

  if (detailQuery.isError) {
    const isNotFound = detailQuery.error.data?.code === 'NOT_FOUND';
    const isInvalidId = detailQuery.error.data?.code === 'BAD_REQUEST';
    return (
      <div className="flex w-full flex-col gap-6">
        <h2 className="text-2xl font-bold">Data export {shortId(exportId)}</h2>
        <Alert variant="destructive">
          <AlertCircle />
          <AlertTitle>
            {isNotFound
              ? 'Data export not found'
              : isInvalidId
                ? 'Invalid export ID'
                : 'Data export could not load'}
          </AlertTitle>
          <AlertDescription>
            {isNotFound
              ? 'No export with this ID exists. Check the ID or return to the export list.'
              : isInvalidId
                ? 'The export ID in this URL is not a valid UUID.'
                : detailQuery.error.message || 'Refresh the page to try again.'}
          </AlertDescription>
        </Alert>
        <Button variant="secondary" size="sm" className="h-fit w-fit" asChild>
          <Link href="/admin/data-exports">Back to data export health</Link>
        </Button>
      </div>
    );
  }

  if (!detail) {
    return <DetailSkeleton />;
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div className="space-y-2">
          <h2 className="text-2xl font-bold">Data export {shortId(detail.id)}</h2>
          <p className="text-muted-foreground max-w-4xl">
            Control-plane detail for one export. Workers and reconcilers act on this state
            automatically; Kilo admins can intervene with the manual controls below.
          </p>
          <p className="text-muted-foreground font-mono text-xs break-all">{detail.id}</p>
        </div>
        <div className="flex h-fit items-center gap-2 self-start">
          <Badge variant="outline" className={statusBadgeClass(detail.status)}>
            {humanizeToken(detail.status)}
          </Badge>
          <Badge variant="outline" className={severityBadgeClass(detail.health.severity)}>
            {severityLabel(detail.health.severity)}
          </Badge>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void detailQuery.refetch()}
            disabled={detailQuery.isFetching}
          >
            <RefreshCw className={detailQuery.isFetching ? 'animate-spin' : ''} /> Refresh
          </Button>
        </div>
      </div>

      {detail.integrityWarnings.length > 0 ? (
        <Alert variant="warning">
          <AlertTriangle />
          <AlertTitle>Integrity warnings present</AlertTitle>
          <AlertDescription>
            {detail.integrityWarnings.map(humanizeToken).join(' · ')}
          </AlertDescription>
        </Alert>
      ) : null}

      <DataExportRecoveryCard detail={detail} />

      <div className="grid items-start gap-4 lg:grid-cols-2">
        <ExportIdentityCard detail={detail} />
        <LifecycleCard detail={detail} />
        <ProcessingCard detail={detail} />
        <HealthCard detail={detail} />
        <AutomaticWorkCard detail={detail} />
        <ArtifactCard detail={detail} />
        <NotificationCard detail={detail} />
        <PartsCard detail={detail} />
        {detail.failureCode || detail.failureMessage ? <FailureCard detail={detail} /> : null}
      </div>

      <OutboxHistoryCard detail={detail} />
    </div>
  );
}
