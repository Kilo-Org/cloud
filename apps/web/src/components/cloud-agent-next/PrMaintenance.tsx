'use client';

import { useId, useState } from 'react';
import Link from 'next/link';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pause, Play, RefreshCw, Settings2 } from 'lucide-react';
import { useTRPC } from '@/lib/trpc/utils';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { CloudAgentSettingsDialog } from './settings/CloudAgentSettingsDialog';
import { maintenanceChatHref } from './maintenance-chat-presentation';
import {
  getMaintenanceRecoveryMessage,
  getMaintenanceRepositoryUrl,
  getMaintenanceStatusLabel,
  getMaintenanceControlsState,
  getMaintenanceRefetchInterval,
} from './pr-maintenance-presentation';
import type { AssociatedPr } from './utils/github-pr-link';

export function PrMaintenance({ pr, sessionId }: { pr: AssociatedPr; sessionId: string }) {
  const expectedRepoUrl = getMaintenanceRepositoryUrl(pr.url);
  if (!expectedRepoUrl || pr.platform !== 'github') return null;
  return (
    <PrAutoFixControls
      key={`${sessionId}:${expectedRepoUrl}:${pr.number}`}
      sessionId={sessionId}
      expectedRepoUrl={expectedRepoUrl}
      expectedPrNumber={pr.number}
    />
  );
}

function PrAutoFixControls(input: {
  sessionId: string;
  expectedRepoUrl: string;
  expectedPrNumber: number;
}) {
  const id = useId();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const settings = useQuery(trpc.cloudAgentSettings.getPullRequestAutoFix.queryOptions());
  const state = useQuery({
    ...trpc.cliSessionsV2.getWatchPr.queryOptions(input),
    refetchInterval: query => getMaintenanceRefetchInterval(query.state.data),
  });
  const watch = state.data;
  const { enabled, legacyWatchActive, canResume, waitingForBudget } =
    getMaintenanceControlsState(watch);
  const onError = (error: { message: string }) => {
    setActionError(error.message);
    void state.refetch();
  };
  const onSuccess = async () => {
    setActionError(null);
    await Promise.all([
      queryClient.invalidateQueries(trpc.cliSessionsV2.getWatchPr.pathFilter()),
      queryClient.invalidateQueries(trpc.cliSessionsV2.list.pathFilter()),
      queryClient.invalidateQueries(trpc.cliSessionsV2.worktreeDetails.pathFilter()),
    ]);
  };
  const enable = useMutation({
    ...trpc.cliSessionsV2.enablePullRequestAutoFix.mutationOptions(),
    onError,
    onSuccess,
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
  const queryError = state.error ?? settings.error;
  const mutationInput = watch ? { watchId: watch.id, generation: watch.generation } : null;
  const recovery = getMaintenanceRecoveryMessage(watch?.lifecycle_reason ?? null);

  return (
    <section
      className="border-border/60 space-y-2 border-t pt-3"
      aria-label="Pull request auto-fix"
      aria-busy={pending}
    >
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`${id}-switch`} className="text-xs">
          Auto-fix
        </Label>
        <div className="flex items-center gap-2">
          <span role="status" className="text-muted-foreground text-xs">
            {state.isPending
              ? 'Loading…'
              : enabled && watch
                ? getMaintenanceStatusLabel(watch)
                : 'Off'}
          </span>
          <Switch
            id={`${id}-switch`}
            checked={enabled}
            disabled={
              pending ||
              state.isPending ||
              Boolean(state.error) ||
              (!enabled && (settings.isPending || Boolean(settings.error))) ||
              legacyWatchActive
            }
            onCheckedChange={checked => {
              if (checked) {
                if (!settings.data) setSettingsOpen(true);
                else enable.mutate(input);
              } else if (mutationInput) stop.mutate(mutationInput);
            }}
          />
        </div>
      </div>
      {(queryError || actionError) && (
        <div role="alert" className="space-y-1 text-xs">
          <p className="text-destructive wrap-anywhere">{actionError ?? queryError?.message}</p>
          {queryError && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                void settings.refetch();
                void state.refetch();
              }}
            >
              Retry
            </Button>
          )}
        </div>
      )}
      {enabled && recovery && (
        <p className="text-muted-foreground text-xs wrap-anywhere">{recovery}</p>
      )}
      {legacyWatchActive && mutationInput && (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => stop.mutate(mutationInput)}
        >
          Stop observation to use auto-fix
        </Button>
      )}
      {enabled && mutationInput && (
        <div className="flex flex-wrap items-center gap-1">
          {watch?.status === 'paused' ? (
            canResume && (
              <Button
                variant="ghost"
                size="sm"
                disabled={pending}
                onClick={() => resume.mutate(mutationInput)}
              >
                <Play />
                Resume
              </Button>
            )
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => pause.mutate(mutationInput)}
            >
              <Pause />
              Pause
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            disabled={pending || waitingForBudget}
            onClick={() => recheck.mutate(mutationInput)}
          >
            <RefreshCw
              className={recheck.isPending ? 'animate-spin motion-reduce:animate-none' : undefined}
            />
            Recheck
          </Button>
          {watch?.activeChat?.chatAvailable && watch.activeChat.sessionId && (
            <Button asChild variant="ghost" size="sm">
              <Link href={maintenanceChatHref(watch.activeChat.sessionId, watch.organization_id)}>
                Open auto-fix
              </Link>
            </Button>
          )}
        </div>
      )}
      <Button
        variant="ghost"
        size="sm"
        className="text-muted-foreground h-7 px-0 text-xs"
        onClick={() => setSettingsOpen(true)}
      >
        <Settings2 className="size-3" />
        Auto-fix settings
      </Button>
      <CloudAgentSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        initialSection="auto-fix"
      />
    </section>
  );
}
