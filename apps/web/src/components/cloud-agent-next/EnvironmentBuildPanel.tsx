'use client';

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, RefreshCw, Square, Hammer } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { environmentSnapshotName } from '../../../../../services/cloud-agent-next/src/shared/environment-snapshot-name';
import {
  useEnvironmentBuildLogs,
  useEnvironmentBuildMutations,
  useEnvironmentBuildStatus,
} from '@/hooks/useCloudAgentEnvironments';
import {
  buildAction,
  buildStageLabel,
  failureText,
  formatAge,
  formatDuration,
  isBuildActive,
  backoffText,
  setupBudgetWarning,
  stalenessText,
  type BuildAction,
  type EnvironmentBuildRequestResult,
  type EnvironmentBuildStatus,
  type EnvironmentBuildSummary,
} from './environment-build-display';
import { EnvironmentSnapshotNotice } from './EnvironmentSnapshotNotice';

type EnvironmentBuildPanelProps = {
  organizationId?: string;
  environmentId: string;
  canManage: boolean;
  hasUnsavedChanges: boolean;
};

/**
 * Keeps the published snapshot separate from replacement build activity.
 * Build logs load only when their dialog is open.
 */
export function EnvironmentBuildPanel({
  organizationId,
  environmentId,
  canManage,
  hasUnsavedChanges,
}: EnvironmentBuildPanelProps) {
  const statusQuery = useEnvironmentBuildStatus(environmentId, { organizationId, poll: true });
  const status = statusQuery.data;
  const action = buildAction(status, { canManage, hasUnsavedChanges });

  return (
    <section
      aria-labelledby="environment-snapshot-heading"
      className="space-y-2 rounded-lg border p-3"
    >
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row">
        <div className="min-w-0">
          <h4 id="environment-snapshot-heading" className="text-sm font-medium">
            Current snapshot
          </h4>
        </div>
      </div>
      {statusQuery.isLoading ? (
        <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label="Loading" />
      ) : !status ? (
        <div className="flex items-center gap-2">
          <p className="text-destructive text-xs">Could not load the snapshot status.</p>
          <Button variant="outline" size="sm" onClick={() => void statusQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <BuildStatusDetail
          status={status}
          organizationId={organizationId}
          environmentId={environmentId}
          canManage={canManage}
        />
      )}
      {status?.supported && (
        <div className="space-y-2 border-t pt-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-sm font-medium">Snapshot build</h4>
            <BuildActionButton
              action={action}
              organizationId={organizationId}
              environmentId={environmentId}
              status={status}
            />
          </div>
          <BuildActivity
            status={status}
            organizationId={organizationId}
            environmentId={environmentId}
            canManage={canManage}
          />
          {action.kind === 'none' && !statusQuery.isError && (
            <p className="text-muted-foreground text-xs">{action.reason}</p>
          )}
          {(action.kind === 'build' || action.kind === 'refresh') && action.disabledReason && (
            <p className="text-muted-foreground text-xs">{action.disabledReason}</p>
          )}
        </div>
      )}
      {status?.published && <EnvironmentSnapshotNotice />}
    </section>
  );
}

function refusalMessage(
  result: Exclude<EnvironmentBuildRequestResult, { status: 'accepted' }>
): string {
  if (result.status === 'rejected')
    return failureText(result.reason) ?? 'The build could not start.';
  if (result.reason === 'revision_changed')
    return 'The configuration changed. Reload and try again.';
  if (result.reason === 'cleanup_pending') return 'The previous builder is still stopping.';
  return 'Another build is running. Cancel it to build the current configuration.';
}

/**
 * Starts or cancels a build and reports the outcome as a toast. The build
 * detail and the environment menu share it, so both apply the same rules.
 */
export function useEnvironmentBuildControl(input: {
  organizationId?: string;
  environmentId: string;
  status: EnvironmentBuildStatus | undefined;
}) {
  const { organizationId, environmentId, status } = input;
  const { requestBuild, isRequesting, cancelBuild } = useEnvironmentBuildMutations();

  const start = async () => {
    if (!status) return;
    try {
      const result = await requestBuild({
        organizationId,
        environmentId,
        expectedRevision: status.configurationRevision,
      });
      if (result.status !== 'accepted') {
        toast.error(refusalMessage(result));
        return;
      }
      toast.success(result.created ? 'Snapshot build started' : 'A build is already running');
    } catch {
      toast.error('Could not start the build. Try again.');
    }
  };

  const cancel = (buildId: string) =>
    cancelBuild.mutate(
      { organizationId, environmentId, buildId },
      { onError: () => toast.error('Could not cancel the build') }
    );

  return { start, cancel, isPending: isRequesting || cancelBuild.isPending };
}

function BuildActionButton({
  action,
  organizationId,
  environmentId,
  status,
}: {
  action: BuildAction;
  organizationId?: string;
  environmentId: string;
  status: EnvironmentBuildStatus | undefined;
}) {
  const control = useEnvironmentBuildControl({ organizationId, environmentId, status });

  if (action.kind === 'none' || !status) return null;
  if (action.kind === 'cancel') {
    return (
      <Button
        variant="outline"
        size="sm"
        className="shrink-0"
        disabled={control.isPending}
        onClick={() => control.cancel(action.buildId)}
      >
        {control.isPending ? (
          <Loader2 className="size-4 animate-spin" />
        ) : (
          <Square className="size-4" />
        )}
        Cancel build
      </Button>
    );
  }
  return (
    <Button
      variant="outline"
      size="sm"
      className="shrink-0"
      disabled={control.isPending || action.disabledReason !== null}
      onClick={() => void control.start()}
    >
      {control.isPending ? (
        <Loader2 className="size-4 animate-spin" />
      ) : action.kind === 'refresh' ? (
        <RefreshCw className="size-4" />
      ) : (
        <Hammer className="size-4" />
      )}
      {action.kind === 'refresh' ? 'Refresh snapshot' : 'Build snapshot'}
    </Button>
  );
}

function BuildStatusDetail({
  status,
  organizationId,
  environmentId,
  canManage,
}: {
  status: EnvironmentBuildStatus;
  organizationId?: string;
  environmentId: string;
  canManage: boolean;
}) {
  if (!status.supported) {
    return (
      <p className="text-muted-foreground text-xs">
        Snapshot builds are unavailable: {status.unsupportedReason ?? 'not supported'}. Sessions run
        setup from the base image.
      </p>
    );
  }
  const published = status.published;
  const staleness = stalenessText(status);
  const budget = setupBudgetWarning(status);
  return (
    <div className="space-y-1.5 text-xs">
      {published ? (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0 space-y-1">
            <p className="flex flex-wrap items-center gap-1.5">
              <time dateTime={new Date(published.capturedAt).toISOString()}>
                {environmentSnapshotName(published.capturedAt)}
              </time>
              {published.stale !== null && <Badge variant="secondary">Stale</Badge>}
            </p>
            <p className="text-muted-foreground break-all">
              {published.repositories !== undefined ? (
                published.repositories.map(repository => (
                  <span key={repository.repoFullName} className="block">
                    <span className="font-mono">{repository.repoFullName}</span> ·{' '}
                    <span className="font-mono">{repository.commit.slice(0, 8)}</span>
                  </span>
                ))
              ) : (
                <>
                  <span className="font-mono">{published.sourceBranch}</span> ·{' '}
                  <span className="font-mono">{published.sourceCommit?.slice(0, 8)}</span>
                </>
              )}
            </p>
          </div>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                Details
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 space-y-3 text-xs">
              <p className="font-medium">Snapshot details</p>
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">Created</dt>
                <dd>{formatAge(published.capturedAt, Date.now())}</dd>
                <dt className="text-muted-foreground">Clone and setup</dt>
                <dd>{formatDuration(published.setupDurationMs)}</dd>
              </dl>
              <p className="text-muted-foreground">
                Clone and setup excludes sandbox startup and snapshot capture.
              </p>
              {canManage && (
                <BuildLog
                  organizationId={organizationId}
                  environmentId={environmentId}
                  buildId={published.buildId}
                  live={false}
                  label="View snapshot build log"
                />
              )}
            </PopoverContent>
          </Popover>
        </div>
      ) : (
        <p className="text-muted-foreground">Not built yet.</p>
      )}
      {staleness && <p className="text-muted-foreground">{staleness}</p>}
      {budget && <p className="text-amber-300">{budget}</p>}
    </div>
  );
}

function BuildActivity({
  status,
  organizationId,
  environmentId,
  canManage,
}: {
  status: EnvironmentBuildStatus;
  organizationId?: string;
  environmentId: string;
  canManage: boolean;
}) {
  const active = status.activeBuild;
  const latest = status.latestBuild;
  const build = active ?? latest;
  return (
    <div className="space-y-1.5 text-xs">
      {active ? (
        <ActiveBuildLine build={active} />
      ) : latest ? (
        <p className={latest.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}>
          {latest.state === 'failed'
            ? `Build failed: ${failureText(latest.failureReason) ?? ''}${latest.failureDetail ? ` (${latest.failureDetail})` : ''}`
            : latest.state === 'succeeded'
              ? 'Build succeeded.'
              : latest.state === 'canceled'
                ? 'Build canceled.'
                : latest.state === 'obsolete'
                  ? `Build superseded: ${failureText(latest.failureReason) ?? 'environment settings changed.'}`
                  : buildStageLabel(latest)}
        </p>
      ) : (
        <p className="text-muted-foreground">
          Build a snapshot to prepare this environment for sessions.
        </p>
      )}
      {active && status.published && active.buildId !== status.published.buildId && (
        <p className="text-muted-foreground">
          The current snapshot stays available while its replacement builds.
        </p>
      )}
      {!active && latest?.state === 'failed' && status.published && (
        <p className="text-muted-foreground">The current snapshot is still available.</p>
      )}
      {status.automaticBackoff && (
        <p className="text-muted-foreground">{backoffText(status.automaticBackoff)}</p>
      )}
      {canManage && build && (
        <BuildLog
          organizationId={organizationId}
          environmentId={environmentId}
          buildId={build.buildId}
          live={isBuildActive(build)}
        />
      )}
    </div>
  );
}

function ActiveBuildLine({ build }: { build: EnvironmentBuildSummary }) {
  return (
    <p className="flex items-center gap-1.5" aria-live="polite">
      <Loader2 className="size-3.5 animate-spin" aria-hidden />
      <span>
        {buildStageLabel(build)} ·{' '}
        {build.trigger === 'session' ? 'started by a session' : 'started manually'}
      </span>
    </p>
  );
}

function BuildLog({
  organizationId,
  environmentId,
  buildId,
  live,
  label = 'View build logs',
}: {
  organizationId?: string;
  environmentId: string;
  buildId: string;
  live: boolean;
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const logs = useEnvironmentBuildLogs(environmentId, buildId, {
    organizationId,
    enabled: open,
    live: open && live,
  });
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Snapshot build logs</DialogTitle>
          <DialogDescription>
            {live ? 'Live output from this build.' : 'Output from this build.'}
          </DialogDescription>
        </DialogHeader>
        {logs.isLoading ? (
          <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label="Loading log" />
        ) : logs.isError && !logs.data ? (
          <div className="flex items-center gap-2 text-xs">
            <p className="text-destructive">Could not load the build log.</p>
            <Button variant="outline" size="sm" onClick={() => void logs.refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            {(logs.data?.lines[0]?.seq ?? 0) > 1 && (
              <p className="text-muted-foreground text-xs">
                Showing the latest 500 retained log lines.
              </p>
            )}
            {logs.data?.truncated && (
              <p className="text-muted-foreground text-xs">Later output was truncated.</p>
            )}
            <pre
              className="bg-muted max-h-[60vh] min-h-40 overflow-auto rounded-md p-3 font-mono text-xs leading-snug whitespace-pre-wrap"
              aria-label="Build log"
            >
              {(logs.data?.lines ?? []).map(line => line.text).join('\n') || 'No output yet.'}
            </pre>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
