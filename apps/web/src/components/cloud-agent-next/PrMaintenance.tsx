'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, RefreshCw } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import { DialogClose } from '@/components/ui/dialog';
import { TimeAgo } from '@/components/shared/TimeAgo';
import { PrMaintenanceEnableForm } from './PrMaintenanceEnableForm';
import { PrMaintenanceHistory, maintenanceChatHref } from './PrMaintenanceHistory';
import {
  getMaintenanceRecoveryMessage,
  getMaintenanceRepositoryUrl,
  getMaintenanceStatusLabel,
  getMaintenancePublicationLabel,
  getMaintenanceControlsState,
  getMaintenanceRefetchInterval,
  getMaintenanceExecutionHelp,
} from './pr-maintenance-presentation';
import type { AssociatedPr } from './utils/github-pr-link';

export function PrMaintenance({ pr, sessionId }: { pr: AssociatedPr; sessionId: string }) {
  const expectedRepoUrl = getMaintenanceRepositoryUrl(pr.url);
  if (!expectedRepoUrl || pr.platform !== 'github') return null;
  return (
    <PrMaintenanceControls
      key={`${sessionId}:${expectedRepoUrl}:${pr.number}`}
      sessionId={sessionId}
      expectedRepoUrl={expectedRepoUrl}
      expectedPrNumber={pr.number}
    />
  );
}

function PrMaintenanceControls(input: {
  sessionId: string;
  expectedRepoUrl: string;
  expectedPrNumber: number;
}) {
  const id = useId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [configure, setConfigure] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const options = useQuery(trpc.cliSessionsV2.getPrWatchOptions.queryOptions(input));
  const state = useQuery({
    ...trpc.cliSessionsV2.getWatchPr.queryOptions(input),
    refetchInterval: query => getMaintenanceRefetchInterval(query.state.data),
  });
  const watch = state.data;
  const {
    automatic: isAutomatic,
    enabled,
    legacyWatchActive,
    canResume,
    waitingForBudget,
  } = getMaintenanceControlsState(watch);
  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries(trpc.cliSessionsV2.getWatchPr.pathFilter()),
      queryClient.invalidateQueries(trpc.cliSessionsV2.getPrWatchOptions.pathFilter()),
      queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter()),
      queryClient.invalidateQueries(trpc.cliSessionsV2.search.pathFilter()),
      queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter()),
    ]);
  };
  const onError = (error: { message: string }) => {
    setActionError(error.message);
    void state.refetch();
  };
  const onSuccess = async () => {
    setActionError(null);
    await refresh();
  };
  const enable = useMutation({
    ...trpc.cliSessionsV2.enableWatchPr.mutationOptions(),
    onError: async error => {
      onError(error);
      await options.refetch();
    },
    onSuccess: async () => {
      await onSuccess();
      setConfigure(false);
    },
  });
  const pause = useMutation({
    ...trpc.cliSessionsV2.pauseWatchPr.mutationOptions(),
    onError,
    onSuccess,
  });
  const resume = useMutation({
    ...trpc.cliSessionsV2.resumeWatchPr.mutationOptions(),
    onError,
    onSuccess,
  });
  const stop = useMutation({
    ...trpc.cliSessionsV2.stopWatchPr.mutationOptions(),
    onError,
    onSuccess,
  });
  const recheck = useMutation({
    ...trpc.cliSessionsV2.recheckWatchPr.mutationOptions(),
    onError,
    onSuccess,
  });
  const pending =
    enable.isPending || pause.isPending || resume.isPending || stop.isPending || recheck.isPending;
  const queryError = state.error ?? options.error;
  const mutationInput = watch ? { watchId: watch.id, generation: watch.generation } : null;
  const recovery = getMaintenanceRecoveryMessage(watch?.lifecycle_reason ?? null);
  const inheritedEnvironment = options.data?.executionSettings.environment;
  const inheritedProfile = options.data?.executionSettings.profile;
  const latestResult = watch?.history.find(attempt => attempt.result !== null)?.result;
  const executionHelp = watch ? getMaintenanceExecutionHelp(watch) : null;

  return (
    <section
      className="border-border/60 space-y-3 border-t pt-3"
      aria-labelledby={`${id}-label`}
      aria-busy={pending}
    >
      <div className="flex min-h-11 items-center justify-between gap-3">
        <Label id={`${id}-label`} htmlFor={`${id}-switch`} className="leading-snug">
          Automatically maintain this PR
        </Label>
        <Switch
          id={`${id}-switch`}
          checked={enabled}
          aria-describedby={`${id}-help${enabled ? ` ${id}-stop-help` : ''}`}
          disabled={
            pending ||
            state.isPending ||
            options.isPending ||
            Boolean(queryError) ||
            legacyWatchActive ||
            (!enabled && options.data?.canEnable !== true)
          }
          onCheckedChange={checked => {
            setActionError(null);
            if (checked) setConfigure(true);
            else if (mutationInput) stop.mutate(mutationInput);
          }}
        />
      </div>
      <p id={`${id}-help`} className="text-muted-foreground text-xs">
        Maintenance can edit, commit, rebase, and push. It uses normal credits. Merging remains your
        action.
      </p>
      {state.isPending && (
        <p role="status" className="text-muted-foreground text-xs">
          Loading maintenance state…
        </p>
      )}
      {(queryError || actionError) && (
        <div role="alert" className="space-y-2 text-xs">
          <p className="text-destructive wrap-anywhere">{actionError ?? queryError?.message}</p>
          {queryError && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void options.refetch();
                void state.refetch();
              }}
            >
              Retry loading maintenance
            </Button>
          )}
        </div>
      )}
      {!enabled && options.data?.unavailableReason && (
        <p className="text-muted-foreground text-xs">{options.data.unavailableReason}</p>
      )}
      {watch && (
        <>
          <div role="status" aria-live="polite" className="space-y-2">
            <Badge variant="outline">{getMaintenanceStatusLabel(watch)}</Badge>
            {watch.rateLimitRetryAt && watch.status === 'watching' && (
              <p className="text-muted-foreground text-xs">
                {watch.rateLimitReason === 'low_budget'
                  ? 'Waiting for available GitHub API budget.'
                  : watch.rateLimitReason === 'throttled'
                    ? 'Waiting before the next GitHub refresh.'
                    : 'Waiting for GitHub rate limit.'}{' '}
                {enabled ? 'Maintenance remains enabled.' : 'Observation remains enabled.'} Retry
                after {new Date(watch.rateLimitRetryAt).toLocaleString()}.
              </p>
            )}
            {recovery && <p className="text-muted-foreground text-xs wrap-anywhere">{recovery}</p>}
            {executionHelp && <p className="text-muted-foreground text-xs">{executionHelp}</p>}
          </div>
          <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">Last event</dt>
            <dd>
              {watch.last_event_at ? (
                <TimeAgo timestamp={watch.last_event_at} />
              ) : (
                'No event received yet'
              )}
            </dd>
            <dt className="text-muted-foreground">Attempts</dt>
            <dd>
              {watch.total_attempts} / {watch.policy.maxTotalAttempts}
            </dd>
            <dt className="text-muted-foreground">Publication</dt>
            <dd className="wrap-anywhere">
              {getMaintenancePublicationLabel(latestResult?.publication)}
            </dd>
          </dl>
          {legacyWatchActive && (
            <p className="text-muted-foreground text-xs">
              This watch only observes PR events. Stop the observation watch first. Then enable
              automatic maintenance with new consent.
            </p>
          )}
          {mutationInput && watch.status !== 'finished' && (
            <>
              {enabled && (
                <p id={`${id}-stop-help`} className="text-muted-foreground text-xs">
                  Pause and Stop also stop any active maintenance chat. Your other chats continue.
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                {enabled &&
                  (watch.status !== 'paused' || canResume) &&
                  (watch.status === 'paused' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => resume.mutate(mutationInput)}
                    >
                      <Play aria-hidden="true" />
                      {resume.isPending ? 'Resuming…' : 'Resume'}
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={pending}
                      onClick={() => pause.mutate(mutationInput)}
                    >
                      <Pause aria-hidden="true" />
                      {pause.isPending ? 'Pausing…' : 'Pause'}
                    </Button>
                  ))}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pending || waitingForBudget}
                  onClick={() => recheck.mutate(mutationInput)}
                >
                  <RefreshCw
                    aria-hidden="true"
                    className={
                      recheck.isPending ? 'animate-spin motion-reduce:animate-none' : undefined
                    }
                  />
                  {recheck.isPending ? 'Rechecking…' : 'Recheck'}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pending}
                  onClick={() => stop.mutate(mutationInput)}
                >
                  {stop.isPending
                    ? 'Stopping…'
                    : isAutomatic
                      ? 'Stop maintenance'
                      : 'Stop observation watch'}
                </Button>
              </div>
            </>
          )}
          {watch.activeChat?.chatAvailable && watch.activeChat.sessionId && (
            <DialogClose asChild>
              <Button asChild variant="outline" size="sm" className="w-full min-h-11">
                <Link
                  href={maintenanceChatHref(
                    watch.activeChat.sessionId,
                    options.data?.organizationId
                  )}
                >
                  Open current maintenance chat
                </Link>
              </Button>
            </DialogClose>
          )}
          {watch.policy.version === 2 && (
            <details className="text-xs">
              <summary className="focus-visible:ring-ring cursor-pointer rounded py-2 font-medium focus-visible:ring-2">
                Recorded execution settings
              </summary>
              <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-2 py-2">
                <dt className="text-muted-foreground">Model</dt>
                <dd className="wrap-anywhere">
                  {watch.policy.model}
                  {watch.policy.variant ? ` · ${watch.policy.variant}` : ''}
                </dd>
                <dt className="text-muted-foreground">Environment</dt>
                <dd className="wrap-anywhere">
                  {inheritedEnvironment && inheritedEnvironment.id === watch.policy.environmentId
                    ? inheritedEnvironment.name
                    : (watch.policy.environmentId ?? 'No saved environment')}
                </dd>
                <dt className="text-muted-foreground">Profile</dt>
                <dd className="wrap-anywhere">
                  {inheritedProfile && inheritedProfile.id === watch.policy.profileId
                    ? inheritedProfile.name
                    : (watch.policy.profileId ?? 'No saved profile')}
                </dd>
                <dt className="text-muted-foreground">Review bots</dt>
                <dd className="wrap-anywhere">
                  {watch.policy.trustedBotLogins.join(', ') || 'None configured'}
                </dd>
              </dl>
            </details>
          )}
          <details className="text-xs">
            <summary className="focus-visible:ring-ring cursor-pointer rounded py-2 font-medium focus-visible:ring-2">
              Maintenance activity and history
            </summary>
            <p className="text-muted-foreground py-2">
              Publication, checks, and review are separate results. A published fix does not mean
              this PR is ready to merge.
            </p>
            <PrMaintenanceHistory
              history={watch.history}
              organizationId={options.data?.organizationId}
            />
            {watch.activity.length > 0 && (
              <details className="mt-3">
                <summary className="cursor-pointer py-2">Watch events</summary>
                <ol className="space-y-2">
                  {watch.activity.map(event => (
                    <li key={event.id} className="flex flex-wrap justify-between gap-x-3 gap-y-1">
                      <span className="wrap-anywhere">
                        {event.kind.replaceAll('_', ' ')}
                        {event.reason ? `: ${event.reason.replaceAll('_', ' ')}` : ''}
                      </span>
                      <TimeAgo timestamp={event.created_at} />
                    </li>
                  ))}
                </ol>
              </details>
            )}
          </details>
        </>
      )}
      {!enabled && !legacyWatchActive && !configure && options.data?.canEnable && (
        <Button variant="outline" size="sm" onClick={() => setConfigure(true)}>
          Review maintenance settings
        </Button>
      )}
      {configure && !enabled && !legacyWatchActive && options.data && (
        <div className="border-border space-y-3 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-medium">Enable automatic maintenance</h3>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setConfigure(false)}
            >
              Cancel
            </Button>
          </div>
          <PrMaintenanceEnableForm
            options={options.data}
            optionsError={options.error?.message}
            pending={pending}
            onEnable={settings => enable.mutate({ ...input, ...settings })}
          />
        </div>
      )}
    </section>
  );
}
