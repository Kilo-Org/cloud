'use client';

import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { inferRouterOutputs } from '@trpc/server';
import { AlertCircle, Check, RefreshCw } from 'lucide-react';
import Link from 'next/link';
import { toast } from 'sonner';

import type { RootRouter } from '@/routers/root-router';
import { useTRPC } from '@/lib/trpc/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { UserDeletionStepKey } from '@kilocode/db/schema-types';
import {
  deletionAttentionHint,
  deletionManualSearchHref,
} from '@/lib/user/deletion-queue/deletion-hints';
import {
  deletionPreflightProgress,
  deletionStepDescription,
  deletionStepLabel,
  deletionStepProgressLabel,
  formatActivityDetail,
  formatAge,
  formatTimestamp,
  humanizeToken,
  statusBadgeClass,
  type DeletionProgressKind,
} from '../deletion-queue-format';

type RouterOutputs = inferRouterOutputs<RootRouter>;
type Detail = RouterOutputs['admin']['userDeletionQueue']['detail'];
type Task = Detail['tasks'][number];
type ActionDialog =
  | { kind: 'cancel' }
  | { kind: 'retry'; stepKey: Task['stepKey'] }
  | { kind: 'preflight' }
  | { kind: 'verify'; stepKey: Task['stepKey'] };

export function DeletionQueueDetailContent({
  requestId,
  compact = false,
}: {
  requestId: string;
  compact?: boolean;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [action, setAction] = useState<ActionDialog | null>(null);
  const detailQuery = useQuery({
    ...trpc.admin.userDeletionQueue.detail.queryOptions({ requestId }),
    refetchInterval: 15_000,
  });

  const invalidate = async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.admin.userDeletionQueue.detail.queryFilter({ requestId })),
      queryClient.invalidateQueries(trpc.admin.userDeletionQueue.list.queryFilter()),
      queryClient.invalidateQueries(trpc.admin.userDeletionQueue.summary.queryFilter()),
    ]);
  };

  if (detailQuery.isLoading && !detailQuery.data) {
    return (
      <div className="flex w-full flex-col gap-6" aria-busy="true">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-56 w-full rounded-xl" />
        <Skeleton className="h-96 w-full rounded-xl" />
      </div>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    return (
      <Alert variant="destructive">
        <AlertCircle />
        <AlertTitle>Request could not load</AlertTitle>
        <AlertDescription>{detailQuery.error?.message ?? 'Not found'}</AlertDescription>
      </Alert>
    );
  }

  const detail = detailQuery.data;
  const request = detail.request;
  if (compact) {
    return (
      <CompactDeletionDetail
        detail={detail}
        requestId={requestId}
        isFetching={detailQuery.isFetching}
        onRefresh={() => void detailQuery.refetch()}
        action={action}
        onAction={setAction}
        onInvalidate={invalidate}
      />
    );
  }

  return (
    <div className="flex w-full flex-col gap-6">
      <div className="flex flex-col justify-between gap-4 lg:flex-row lg:items-start">
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            {compact ? null : <h2 className="text-2xl font-bold">Deletion request</h2>}
            <Badge variant="outline" className={statusBadgeClass(request.status)}>
              {humanizeToken(request.status)}
            </Badge>
            {request.stale ? (
              <Badge
                variant="outline"
                className="border-status-warning-border bg-status-warning-surface text-status-warning"
              >
                No progress 7d
              </Badge>
            ) : null}
          </div>
          {compact ? null : (
            <p className="text-muted-foreground font-mono text-sm break-all">{request.id}</p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void detailQuery.refetch()}
            disabled={detailQuery.isFetching}
          >
            <RefreshCw className={detailQuery.isFetching ? 'animate-spin' : undefined} /> Refresh
          </Button>
          {request.status === 'pending' ? (
            <Button variant="destructive" size="sm" onClick={() => setAction({ kind: 'cancel' })}>
              Cancel request
            </Button>
          ) : null}
          {request.status === 'pending' && request.preflightAttentionCode ? (
            <Button variant="secondary" size="sm" onClick={() => setAction({ kind: 'preflight' })}>
              Retry preflight
            </Button>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Request</CardTitle>
          <CardDescription>
            Open requests show the raw target. Completed and cancelled requests stay redacted.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <dl className="grid gap-3 sm:grid-cols-2">
            <DetailField label="Target">
              {request.email ? (
                <span className="font-mono">{request.email}</span>
              ) : (
                <span className="text-muted-foreground">Redacted</span>
              )}
            </DetailField>
            <DetailField label="User ID">
              {request.userId ? (
                <Link
                  className="text-link hover:text-link-hover font-mono text-xs underline"
                  href={`/admin/users/${encodeURIComponent(request.userId)}`}
                >
                  {request.userId}
                </Link>
              ) : (
                <span className="text-muted-foreground">None</span>
              )}
            </DetailField>
            <DetailField label="Pylon ticket">
              <span className="font-mono text-xs">{request.pylonTicket ?? '—'}</span>
            </DetailField>
            <DetailField label="Catalog">{`v${request.catalogVersion}`}</DetailField>
            <DetailField label="Cloud subject">
              {humanizeToken(request.cloudSubjectResolution)}
            </DetailField>
            <DetailField label="Preflight">
              {request.preflightAttentionCode ?? '—'}
              {request.preflightAttentionCode ? (
                <p className="text-muted-foreground mt-1 text-xs">
                  {deletionAttentionHint(request.preflightAttentionCode)?.action}
                </p>
              ) : null}
            </DetailField>
            <DetailField label="Created">{formatTimestamp(request.createdAt)}</DetailField>
            <DetailField label="Last progress">
              {formatTimestamp(request.lastProgressAt)}
              {` · ${formatAge(request.lastProgressAt, detail.asOf)}`}
            </DetailField>
            <DetailField label="Anonymized">{formatTimestamp(request.anonymizedAt)}</DetailField>
            <DetailField label="Completed">{formatTimestamp(request.completedAt)}</DetailField>
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Steps</CardTitle>
          <CardDescription>Preflight, then cleanup, then Cloud user, then Pylon.</CardDescription>
        </CardHeader>
        <CardContent className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Task</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Error</TableHead>
                <TableHead>Attempts</TableHead>
                <TableHead>Progress</TableHead>
                <TableHead>Next</TableHead>
                <TableHead>Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.tasks.map(task => {
                const stuck =
                  task.status === 'needs_attention' || task.status === 'manual_action_required';
                const hint = stuck ? deletionAttentionHint(task.lastErrorCode) : null;
                const search = stuck
                  ? deletionManualSearchHref({
                      stepKey: task.stepKey,
                      email: request.email,
                    })
                  : null;
                return (
                  <TableRow key={task.stepKey}>
                    <TableCell className="text-xs">{deletionStepLabel(task.stepKey)}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={statusBadgeClass(task.status)}>
                        {humanizeToken(task.status)}
                      </Badge>
                    </TableCell>
                    <TableCell className="max-w-72 text-xs">
                      <span className="font-mono">{task.lastErrorCode ?? '—'}</span>
                      {hint ? (
                        <p className="text-muted-foreground mt-1">
                          {hint.title}. {hint.action}
                        </p>
                      ) : null}
                      {search ? (
                        <a
                          href={search.href}
                          target="_blank"
                          rel="noreferrer"
                          className="text-link hover:text-link-hover mt-1 inline-block underline"
                        >
                          {search.label}
                        </a>
                      ) : null}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">
                      {task.windowAttemptCount}/{task.lifetimeAttemptCount}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums">{task.processedCount}</TableCell>
                    <TableCell className="text-xs">{formatTimestamp(task.availableAt)}</TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-2">
                        {stuck ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setAction({ kind: 'retry', stepKey: task.stepKey })}
                          >
                            Retry
                          </Button>
                        ) : null}
                        {stuck && task.allowsManualVerification ? (
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setAction({ kind: 'verify', stepKey: task.stepKey })}
                          >
                            Mark done
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Activity</CardTitle>
            <CardDescription>Redacted operational stream.</CardDescription>
          </CardHeader>
          <CardContent className="flex max-h-96 flex-col gap-3 overflow-y-auto">
            {detail.activity.length === 0 ? (
              <p className="text-muted-foreground text-sm">No activity yet.</p>
            ) : (
              detail.activity.map(item => (
                <div key={item.id} className="flex flex-col gap-0.5 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{humanizeToken(item.eventType)}</span>
                    <span className="text-muted-foreground text-xs">
                      {formatTimestamp(item.createdAt)}
                    </span>
                  </div>
                  <p className="text-muted-foreground font-mono text-xs">
                    {formatActivityDetail(item)}
                  </p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Audit</CardTitle>
            <CardDescription>Immutable PII-minimal events.</CardDescription>
          </CardHeader>
          <CardContent className="flex max-h-96 flex-col gap-3 overflow-y-auto">
            {detail.audit.length === 0 ? (
              <p className="text-muted-foreground text-sm">No audit events.</p>
            ) : (
              detail.audit.map(item => (
                <div key={item.id} className="flex flex-col gap-0.5 text-sm">
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{humanizeToken(item.eventType)}</span>
                    <span className="text-muted-foreground text-xs">
                      {formatTimestamp(item.createdAt)}
                    </span>
                  </div>
                  <p className="text-muted-foreground font-mono text-xs">{item.subjectKey}</p>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>

      <ActionDialogs
        requestId={requestId}
        action={action}
        onOpenChange={open => {
          if (!open) setAction(null);
        }}
        onDone={invalidate}
      />
    </div>
  );
}

function CompactDeletionDetail({
  detail,
  requestId,
  isFetching,
  onRefresh,
  action,
  onAction,
  onInvalidate,
}: {
  detail: Detail;
  requestId: string;
  isFetching: boolean;
  onRefresh: () => void;
  action: ActionDialog | null;
  onAction: (action: ActionDialog | null) => void;
  onInvalidate: () => Promise<void>;
}) {
  const request = detail.request;
  const preflightKind = deletionPreflightProgress(request);
  const ticket = request.pylonTicket ? `#${request.pylonTicket.replace(/^#/, '')}` : null;
  const stuckTask = detail.tasks.find(
    task => task.status === 'needs_attention' || task.status === 'manual_action_required'
  );
  const attention =
    request.preflightAttentionCode || stuckTask
      ? deletionAttentionHint(request.preflightAttentionCode ?? stuckTask?.lastErrorCode)
      : null;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pb-4">
        <div className="space-y-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="truncate text-lg font-semibold">{request.email ?? 'Redacted'}</h3>
            <Badge variant="outline" className={statusBadgeClass(request.status)}>
              {humanizeToken(request.status)}
            </Badge>
          </div>
          <p className="text-muted-foreground font-mono text-xs">
            {[
              ticket,
              `Started ${formatTimestamp(request.createdAt)}`,
              request.completedAt
                ? `Completed ${formatTimestamp(request.completedAt)}`
                : `Last progress ${formatAge(request.lastProgressAt, detail.asOf)}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          {request.userId ? (
            <Link
              className="text-link hover:text-link-hover font-mono text-xs underline"
              href={`/admin/users/${encodeURIComponent(request.userId)}`}
            >
              Open Cloud user
            </Link>
          ) : null}
        </div>

        {attention ? (
          <div className="border-status-warning-border bg-status-warning-surface flex flex-col gap-3 rounded-lg border p-3">
            <div>
              <p className="text-status-warning text-sm font-medium">{attention.title}</p>
              <p className="text-muted-foreground mt-1 text-xs">{attention.action}</p>
            </div>
            <div className="flex flex-wrap gap-2">
              {request.preflightAttentionCode ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAction({ kind: 'preflight' })}
                >
                  Retry preflight
                </Button>
              ) : null}
              {stuckTask ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAction({ kind: 'retry', stepKey: stuckTask.stepKey })}
                >
                  Retry {deletionStepLabel(stuckTask.stepKey)}
                </Button>
              ) : null}
              {stuckTask?.allowsManualVerification ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onAction({ kind: 'verify', stepKey: stuckTask.stepKey })}
                >
                  Mark done
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="border-border bg-muted/30 flex flex-col gap-4 rounded-xl border p-3">
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Progress
          </p>
          <ProgressGroup label="Preflight" hint="Before cleanup starts">
            <ProgressStepTile
              label="Preflight"
              description={
                preflightKind === 'stuck' && request.preflightAttentionCode
                  ? request.preflightAttentionCode
                  : 'Confirm identity, subscriptions, and delete-ready'
              }
              kind={preflightKind}
            />
          </ProgressGroup>
          {PROGRESS_GROUPS.map((group, groupIndex) => {
            const tasks = group.stepKeys.flatMap(stepKey => {
              const task = detail.tasks.find(item => item.stepKey === stepKey);
              return task ? [task] : [];
            });
            if (tasks.length === 0) return null;
            const unlocked =
              preflightKind === 'finished' && isProgressGroupUnlocked(detail.tasks, groupIndex);
            return (
              <ProgressGroup key={group.label} label={group.label} hint={group.hint} showThen>
                <div
                  className={
                    group.stepKeys.length > 1
                      ? 'grid grid-cols-1 gap-2 sm:grid-cols-2'
                      : 'flex flex-col gap-2'
                  }
                >
                  {tasks.map(task => (
                    <CatalogProgressTile
                      key={task.stepKey}
                      task={task}
                      current={unlocked && isOpenTask(task.status)}
                    />
                  ))}
                </div>
              </ProgressGroup>
            );
          })}
        </div>

        <Tabs defaultValue="activity">
          <TabsList>
            <TabsTrigger value="activity">Activity ({detail.activity.length})</TabsTrigger>
            <TabsTrigger value="audit">Audit ({detail.audit.length})</TabsTrigger>
          </TabsList>
          <TabsContent value="activity" className="mt-3 space-y-2">
            {detail.activity.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-xs">No activity yet.</p>
            ) : (
              detail.activity.map(item => (
                <div
                  key={item.id}
                  className="border-border bg-card flex flex-col gap-1 rounded-lg border p-3 text-xs"
                >
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{humanizeToken(item.eventType)}</span>
                    <span className="text-muted-foreground">{formatTimestamp(item.createdAt)}</span>
                  </div>
                  <p className="text-muted-foreground font-mono">{formatActivityDetail(item)}</p>
                </div>
              ))
            )}
          </TabsContent>
          <TabsContent value="audit" className="mt-3 space-y-2">
            {detail.audit.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-xs">No audit events yet.</p>
            ) : (
              detail.audit.map(item => (
                <div
                  key={item.id}
                  className="border-border bg-card flex flex-col gap-1 rounded-lg border p-3 text-xs"
                >
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{humanizeToken(item.eventType)}</span>
                    <span className="text-muted-foreground">{formatTimestamp(item.createdAt)}</span>
                  </div>
                  <p className="text-muted-foreground font-mono">{item.subjectKey}</p>
                </div>
              ))
            )}
          </TabsContent>
        </Tabs>
      </div>

      <div className="border-border flex shrink-0 items-center justify-between gap-2 border-t pt-3">
        {request.status === 'pending' ? (
          <Button variant="ghost" size="sm" onClick={() => onAction({ kind: 'cancel' })}>
            Cancel request
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onRefresh} disabled={isFetching}>
            <RefreshCw className={isFetching ? 'animate-spin' : undefined} /> Refresh
          </Button>
        </div>
      </div>

      <ActionDialogs
        requestId={requestId}
        action={action}
        onOpenChange={open => {
          if (!open) onAction(null);
        }}
        onDone={onInvalidate}
      />
    </div>
  );
}

const PROGRESS_GROUPS = [
  {
    label: 'Cleanup',
    hint: 'Can run together',
    stepKeys: [
      UserDeletionStepKey.KiloclawDestroy,
      UserDeletionStepKey.Customerio,
      UserDeletionStepKey.CliV1Blobs,
      UserDeletionStepKey.CliV2Sessions,
      UserDeletionStepKey.UsagePromptPrefixes,
      UserDeletionStepKey.Posthog,
      UserDeletionStepKey.Substack,
    ],
  },
  {
    label: 'Cloud user',
    hint: 'After cleanup finishes',
    stepKeys: [UserDeletionStepKey.Anonymize],
  },
  {
    label: 'Pylon reply',
    hint: 'After the Cloud user is anonymized',
    stepKeys: [UserDeletionStepKey.PylonReply],
  },
  {
    label: 'Pylon finalize',
    hint: 'After the reply is posted',
    stepKeys: [UserDeletionStepKey.PylonFinalize],
  },
  {
    label: 'Pylon delete',
    hint: 'After the ticket is tagged and closed',
    stepKeys: [UserDeletionStepKey.PylonContact],
  },
  {
    label: 'CSA support DB',
    hint: 'After the Pylon contact is deleted',
    stepKeys: [UserDeletionStepKey.CsaSupportDb],
  },
] as const;

function isFinishedTask(status: string): boolean {
  return status === 'succeeded' || status === 'not_applicable' || status === 'manually_verified';
}

function isStuckTask(status: string): boolean {
  return status === 'needs_attention' || status === 'manual_action_required';
}

function isOpenTask(status: string): boolean {
  return !isFinishedTask(status) && !isStuckTask(status);
}

function isProgressGroupUnlocked(tasks: Task[], groupIndex: number): boolean {
  return PROGRESS_GROUPS.slice(0, groupIndex).every(group =>
    group.stepKeys.every(stepKey => {
      const task = tasks.find(item => item.stepKey === stepKey);
      return !task || isFinishedTask(task.status);
    })
  );
}

function ProgressGroup({
  label,
  hint,
  showThen = false,
  children,
}: {
  label: string;
  hint: string;
  showThen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      {showThen ? (
        <p className="text-muted-foreground text-center text-[11px] tracking-wide uppercase">
          then
        </p>
      ) : null}
      <div>
        <p className="text-foreground text-xs font-medium">{label}</p>
        <p className="text-muted-foreground text-[11px]">{hint}</p>
      </div>
      {children}
    </div>
  );
}

function CatalogProgressTile({ task, current }: { task: Task; current: boolean }) {
  const finished = isFinishedTask(task.status);
  const stuck = isStuckTask(task.status);
  const countLabel = deletionStepProgressLabel(
    task.stepKey,
    task.processedCount,
    task.scannedCount
  );
  const description =
    stuck && task.lastErrorCode
      ? task.lastErrorCode
      : current && countLabel
        ? `${countLabel} so far`
        : finished && countLabel
          ? countLabel
          : deletionStepDescription(task.stepKey);
  return (
    <ProgressStepTile
      label={deletionStepLabel(task.stepKey)}
      description={description}
      kind={finished ? 'finished' : stuck ? 'stuck' : current ? 'current' : 'idle'}
    />
  );
}

function ProgressStepTile({
  label,
  description,
  kind,
}: {
  label: string;
  description: string;
  kind: DeletionProgressKind;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2.5 rounded-lg border p-2.5 text-xs',
        kind === 'finished'
          ? 'border-status-success-border bg-status-success-surface'
          : kind === 'stuck'
            ? 'border-status-warning-border bg-status-warning-surface'
            : kind === 'current'
              ? 'border-status-info-border bg-status-info-surface'
              : 'border-border bg-card text-muted-foreground'
      )}
    >
      <span className="shrink-0 font-semibold">
        {kind === 'finished' ? <Check className="size-3.5" /> : kind === 'current' ? '▸' : '·'}
      </span>
      <div className="min-w-0">
        <p className="text-foreground font-medium">{label}</p>
        <p className="text-muted-foreground mt-0.5">{description}</p>
      </div>
    </div>
  );
}

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function ActionDialogs({
  requestId,
  action,
  onOpenChange,
  onDone,
}: {
  requestId: string;
  action: ActionDialog | null;
  onOpenChange: (open: boolean) => void;
  onDone: () => Promise<void>;
}) {
  const trpc = useTRPC();
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  const cancelMutation = useMutation(trpc.admin.userDeletionQueue.cancel.mutationOptions());
  const retryMutation = useMutation(trpc.admin.userDeletionQueue.retryTask.mutationOptions());
  const preflightMutation = useMutation(
    trpc.admin.userDeletionQueue.retryPreflight.mutationOptions()
  );
  const verifyMutation = useMutation(trpc.admin.userDeletionQueue.verifyTask.mutationOptions());

  const reset = () => {
    setReason('');
    setEvidence('');
  };

  return (
    <Dialog
      open={action !== null}
      onOpenChange={open => {
        if (!open) reset();
        onOpenChange(open);
      }}
    >
      <DialogContent>
        {action?.kind === 'cancel' ? (
          <>
            <DialogHeader>
              <DialogTitle>Cancel pending request</DialogTitle>
              <DialogDescription>
                Allowed only while the request is still pending and no destructive work has started.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="secondary" onClick={() => onOpenChange(false)}>
                Keep request
              </Button>
              <Button
                variant="destructive"
                disabled={cancelMutation.isPending}
                onClick={async () => {
                  try {
                    await cancelMutation.mutateAsync({ requestId });
                    toast.success('Request cancelled');
                    reset();
                    onOpenChange(false);
                    await onDone();
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Cancel failed');
                  }
                }}
              >
                Cancel request
              </Button>
            </DialogFooter>
          </>
        ) : null}
        {action?.kind === 'retry' || action?.kind === 'preflight' ? (
          <>
            <DialogHeader>
              <DialogTitle>
                {action.kind === 'preflight' ? 'Retry preflight' : `Retry ${action.stepKey}`}
              </DialogTitle>
              <DialogDescription>A reason is required and is audited.</DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-2">
              <Label htmlFor="retry-reason">Reason</Label>
              <Textarea
                id="retry-reason"
                value={reason}
                onChange={event => setReason(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                disabled={!reason.trim() || retryMutation.isPending || preflightMutation.isPending}
                onClick={async () => {
                  try {
                    if (action.kind === 'preflight') {
                      await preflightMutation.mutateAsync({ requestId, reason: reason.trim() });
                    } else {
                      await retryMutation.mutateAsync({
                        requestId,
                        stepKey: action.stepKey,
                        reason: reason.trim(),
                      });
                    }
                    toast.success('Retry recorded');
                    reset();
                    onOpenChange(false);
                    await onDone();
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Retry failed');
                  }
                }}
              >
                Retry
              </Button>
            </DialogFooter>
          </>
        ) : null}
        {action?.kind === 'verify' ? (
          <>
            <DialogHeader>
              <DialogTitle>{`Mark ${action.stepKey} done`}</DialogTitle>
              <DialogDescription>
                Use this only after you finished the work outside the queue. Reason and evidence
                must be PII-free. Do not include email addresses.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-2">
                <Label htmlFor="verify-reason">Reason</Label>
                <Textarea
                  id="verify-reason"
                  value={reason}
                  onChange={event => setReason(event.target.value)}
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="verify-evidence">Evidence</Label>
                <Textarea
                  id="verify-evidence"
                  value={evidence}
                  onChange={event => setEvidence(event.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button
                disabled={!reason.trim() || !evidence.trim() || verifyMutation.isPending}
                onClick={async () => {
                  try {
                    await verifyMutation.mutateAsync({
                      requestId,
                      stepKey: action.stepKey,
                      reason: reason.trim(),
                      evidence: evidence.trim(),
                    });
                    toast.success(`${action.stepKey} marked done`);
                    reset();
                    onOpenChange(false);
                    await onDone();
                  } catch (error) {
                    toast.error(error instanceof Error ? error.message : 'Verification failed');
                  }
                }}
              >
                Record as done
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
