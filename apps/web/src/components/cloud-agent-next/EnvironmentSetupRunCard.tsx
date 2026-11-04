'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  Ban,
  ChevronDown,
  CircleCheck,
  CircleX,
  ExternalLink,
  FlaskConical,
  GitPullRequest,
  Loader2,
  MessageCircleQuestion,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import {
  type EnvironmentSetupRunStatus,
  type EnvironmentSetupVerification,
} from '@kilocode/cloud-agent-profile';
import { TRPCClientError } from '@trpc/client';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useConfirm } from '@/components/ui/confirm';
import { useEnvironmentSetupRunMutations } from '@/hooks/useEnvironmentSetupRuns';
import type { SetupRunResponse } from '@/lib/cloud-agent/environment-setup/response';
import { buildCloudChatSessionPath } from './cloud-session-fork';
import {
  setupRunActions,
  setupRunBadge,
  setupRunChanges,
  setupRunNetworkLabel,
  setupRunStopNotice,
  setupRunVerificationSummary,
  type SetupRunAction,
} from './environment-setup-run-display';
import { cn } from '@/lib/utils';

type EnvironmentSetupRunCardProps = {
  run: SetupRunResponse;
  organizationId?: string;
  canManage: boolean;
};

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'The action could not be completed.';
}

function isRevertAnywayConflict(error: unknown): boolean {
  return (
    error instanceof TRPCClientError &&
    error.data?.code === 'CONFLICT' &&
    error.message.includes('Revert anyway')
  );
}

function statusIcon(status: EnvironmentSetupRunStatus) {
  switch (status) {
    case 'starting':
    case 'running':
      return Loader2;
    case 'needs_input':
      return MessageCircleQuestion;
    case 'verifying':
      return FlaskConical;
    case 'waiting_for_merge':
      return GitPullRequest;
    case 'publish_conflict':
      return TriangleAlert;
    case 'failed':
      return CircleX;
    case 'published':
      return CircleCheck;
    case 'reverted':
      return Undo2;
    case 'cancelled':
      return Ban;
  }
}

export function EnvironmentSetupRunCard({
  run,
  organizationId,
  canManage,
}: EnvironmentSetupRunCardProps) {
  const [open, setOpen] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const confirm = useConfirm();
  const { publish, revert, cancel, resume, buildSnapshot } = useEnvironmentSetupRunMutations();

  const badge = setupRunBadge(run.status);
  const StatusIcon = statusIcon(run.status);
  const environmentName = run.environmentName;
  const busy =
    publish.isPending ||
    revert.isPending ||
    cancel.isPending ||
    resume.isPending ||
    buildSnapshot.isPending;

  const runAction = async (action: () => Promise<unknown>) => {
    setActionError(null);
    try {
      await action();
    } catch (error) {
      setActionError(errorText(error));
    }
  };

  const stoppedSection =
    (run.status === 'running' && run.agentState?.kind === 'stopped') ||
    (run.status === 'failed' && run.cloudAgentSessionId !== null);
  const stopNotice = setupRunStopNotice(run);
  const verificationLimitReached = run.statusReason === 'verification_limit_reached';
  const changes = run.diff === null ? [] : setupRunChanges(run.diff);
  const isNewEnvironment = run.targetEnvironmentId === null;
  const actions = setupRunActions(run, { canManage, hasStoppedSection: stoppedSection });

  const revertRun = async (force: boolean) => {
    setActionError(null);
    try {
      await revert.mutateAsync({ organizationId, runId: run.id, force });
    } catch (error) {
      if (force || !isRevertAnywayConflict(error)) {
        setActionError(errorText(error));
        return;
      }
      const retry = await confirm({
        title: 'Revert anyway?',
        description: 'The environment changed after publication. Overwrite those changes?',
        confirmLabel: 'Revert anyway',
        destructive: true,
      });
      if (retry) await revertRun(true);
    }
  };

  const handleRevert = async () => {
    const confirmed = await confirm({
      title: isNewEnvironment ? 'Delete environment?' : 'Revert this setup?',
      description: isNewEnvironment
        ? 'Delete the environment this run created?'
        : 'Restore the configuration from before this run?',
      confirmLabel: isNewEnvironment ? 'Delete environment' : 'Revert',
      destructive: true,
    });
    if (confirmed) await revertRun(false);
  };

  const handlePublish = async (force: boolean) => {
    const confirmed = await confirm(
      force
        ? {
            title: 'Publish anyway?',
            description: 'Overwrite changes made to the environment while the agent worked?',
            confirmLabel: 'Publish anyway',
            destructive: true,
          }
        : {
            title: 'Publish now?',
            description:
              'Sessions on the default branch will fail setup until the pull request is merged.',
            confirmLabel: 'Publish now',
          }
    );
    if (!confirmed) return;
    await runAction(() => publish.mutateAsync({ organizationId, runId: run.id, force }));
  };

  const actionButton = (action: SetupRunAction) => {
    const className = 'pointer-coarse:min-h-11';
    switch (action) {
      case 'revert':
        return (
          <Button
            key={action}
            type="button"
            size="sm"
            variant="destructive"
            className={className}
            disabled={busy}
            onClick={() => void handleRevert()}
          >
            {isNewEnvironment ? 'Delete environment' : 'Revert'}
          </Button>
        );
      case 'buildSnapshot':
        return (
          <Button
            key={action}
            type="button"
            size="sm"
            variant="secondary"
            className={className}
            disabled={busy}
            onClick={() =>
              void runAction(() => buildSnapshot.mutateAsync({ organizationId, runId: run.id }))
            }
          >
            Build snapshot now
          </Button>
        );
      case 'publishAnyway':
        return (
          <Button
            key={action}
            type="button"
            size="sm"
            className={className}
            disabled={busy}
            onClick={() => void handlePublish(true)}
          >
            Publish anyway
          </Button>
        );
      case 'publishNow':
        return (
          <Button
            key={action}
            type="button"
            size="sm"
            className={className}
            disabled={busy}
            onClick={() => void handlePublish(false)}
          >
            Publish now
          </Button>
        );
      case 'discard':
      case 'cancel':
        return (
          <Button
            key={action}
            type="button"
            size="sm"
            variant="ghost"
            className={className}
            disabled={busy}
            onClick={() =>
              void runAction(() => cancel.mutateAsync({ organizationId, runId: run.id }))
            }
          >
            {action === 'discard' ? 'Discard' : 'Cancel'}
          </Button>
        );
    }
  };

  return (
    <section className="bg-card rounded-lg border" aria-label="Environment setup">
      <Collapsible open={open} onOpenChange={setOpen}>
        <div className="flex flex-wrap items-center gap-2 px-3 py-2">
          <CollapsibleTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground -ml-2 h-8 gap-1 px-2 pointer-coarse:min-h-11"
            >
              <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
              <span className="text-foreground font-medium">Environment setup</span>
            </Button>
          </CollapsibleTrigger>
          <Badge variant={badge.variant}>
            <StatusIcon
              className={cn(
                run.status === 'starting' || run.status === 'running' ? 'animate-spin' : undefined
              )}
              aria-hidden="true"
            />
            {badge.text}
          </Badge>
          {environmentName && (
            <span className="text-muted-foreground min-w-0 truncate text-xs">
              {environmentName}
            </span>
          )}
        </div>
        <CollapsibleContent>
          <div className="space-y-3 border-t px-3 py-3">
            {stopNotice !== null && (
              <div className="space-y-2">
                <p className="text-sm">{stopNotice}</p>
                {stoppedSection && canManage && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      type="button"
                      size="sm"
                      className="pointer-coarse:min-h-11"
                      disabled={busy}
                      onClick={() =>
                        void runAction(() =>
                          resume.mutateAsync({
                            organizationId,
                            runId: run.id,
                            raiseVerificationLimit: verificationLimitReached,
                          })
                        )
                      }
                    >
                      {verificationLimitReached ? 'Allow more tests' : 'Continue'}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      className="pointer-coarse:min-h-11"
                      disabled={busy}
                      onClick={() =>
                        void runAction(() => cancel.mutateAsync({ organizationId, runId: run.id }))
                      }
                    >
                      Discard
                    </Button>
                  </div>
                )}
              </div>
            )}

            {changes.length > 0 && (
              <div className="space-y-1.5">
                <h4 className="text-sm font-medium">Changes</h4>
                <ul className="space-y-1 text-sm">
                  {changes.map((change, index) =>
                    change.kind === 'script' ? (
                      <li key={`script-${index}`}>
                        <Collapsible>
                          <CollapsibleTrigger asChild>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="h-7 px-1.5 text-sm font-normal pointer-coarse:min-h-11"
                            >
                              Setup script changed
                            </Button>
                          </CollapsibleTrigger>
                          <CollapsibleContent>
                            <div className="grid gap-2 pt-1 sm:grid-cols-2">
                              <div>
                                <p className="text-muted-foreground text-xs">Before</p>
                                <pre className="bg-muted mt-1 max-h-48 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap break-words">
                                  {change.before || '(empty)'}
                                </pre>
                              </div>
                              <div>
                                <p className="text-muted-foreground text-xs">After</p>
                                <pre className="bg-muted mt-1 max-h-48 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap break-words">
                                  {change.after || '(empty)'}
                                </pre>
                              </div>
                            </div>
                          </CollapsibleContent>
                        </Collapsible>
                      </li>
                    ) : (
                      <li key={`text-${index}`} className="text-muted-foreground">
                        {change.text}
                      </li>
                    )
                  )}
                </ul>
              </div>
            )}

            {(run.pendingVerification !== null || run.lastVerification !== null) && (
              <div className="space-y-1.5">
                <h4 className="text-sm font-medium">Latest test</h4>
                {run.pendingVerification !== null ? (
                  <p className="text-muted-foreground text-sm">
                    Testing revision {run.pendingVerification.configurationRevision}…
                  </p>
                ) : run.lastVerification !== null ? (
                  <VerificationDetail
                    verification={run.lastVerification}
                    organizationId={organizationId}
                  />
                ) : null}
              </div>
            )}

            {run.setupPullRequest !== null && (
              <div className="space-y-1">
                <h4 className="text-sm font-medium">Setup pull request</h4>
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <a
                    href={run.setupPullRequest.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-link inline-flex items-center gap-1 underline underline-offset-4"
                  >
                    {run.setupPullRequest.repoFullName}#{run.setupPullRequest.number}
                    <ExternalLink className="size-3.5" aria-hidden="true" />
                  </a>
                  <span className="text-muted-foreground capitalize">
                    {run.setupPullRequest.state}
                  </span>
                </p>
                <p className="text-muted-foreground text-xs">
                  The environment is saved after this pull request is merged.
                </p>
              </div>
            )}

            {actionError && (
              <Alert variant="destructive">
                <AlertDescription>{actionError}</AlertDescription>
              </Alert>
            )}

            {actions.length > 0 && (
              <div className="flex flex-wrap gap-2">{actions.map(actionButton)}</div>
            )}
          </div>
        </CollapsibleContent>
      </Collapsible>
    </section>
  );
}

function VerificationDetail({
  verification,
  organizationId,
}: {
  verification: EnvironmentSetupVerification;
  organizationId?: string;
}) {
  const network = setupRunNetworkLabel(verification.egressMode);
  return (
    <div className="space-y-1.5 text-sm">
      {verification.configurationRevision !== null && (
        <p className="text-muted-foreground text-xs">
          Revision {verification.configurationRevision}
        </p>
      )}
      <p>{setupRunVerificationSummary(verification)}</p>
      {network && <p className="text-muted-foreground text-xs">Network: {network}</p>}
      {verification.results.length > 0 && (
        <div className="space-y-1">
          <ul className="space-y-1">
            {verification.results.map(result => (
              <li key={result.name}>
                <div className="flex items-center gap-1.5">
                  {result.passed ? (
                    <CircleCheck className="text-status-success-icon size-4" aria-hidden="true" />
                  ) : (
                    <CircleX className="text-destructive size-4" aria-hidden="true" />
                  )}
                  <span>{result.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {result.passed ? 'Passed' : 'Failed'}
                  </span>
                </div>
                {result.evidence !== '' && (
                  <Collapsible>
                    <CollapsibleTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-muted-foreground h-7 px-1.5 text-xs font-normal pointer-coarse:min-h-11"
                        aria-label={`Reported by the agent for ${result.name}`}
                      >
                        Reported by the agent
                      </Button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <pre className="bg-muted mt-1 max-h-48 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap break-words">
                        {result.evidence}
                      </pre>
                    </CollapsibleContent>
                  </Collapsible>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {verification.childKiloSessionId !== null && (
        <Link
          href={buildCloudChatSessionPath(organizationId, verification.childKiloSessionId)}
          className="text-link text-sm underline underline-offset-4 pointer-coarse:min-h-11 pointer-coarse:content-center"
        >
          Open test chat
        </Link>
      )}
    </div>
  );
}
