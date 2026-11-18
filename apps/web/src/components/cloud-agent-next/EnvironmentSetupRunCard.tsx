'use client';

import { useState } from 'react';
import Link from 'next/link';
import {
  CheckCircle2,
  CircleHelp,
  Clock,
  Loader2,
  OctagonX,
  RotateCcw,
  TriangleAlert,
  XCircle,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription } from '@/components/ui/alert';
import {
  useEnvironmentSetupEnabled,
  useEnvironmentSetupRunMutations,
  isOpenEnvironmentSetupRun,
  type SetupRunResponse,
} from '@/hooks/useEnvironmentSetupRuns';
import { EnvironmentSetupConfirmDialog } from './EnvironmentSetupConfirmDialog';
import {
  environmentSetupStatusLabels,
  canContinueEnvironmentSetup,
  formatEnvironmentSetupDiff,
  formatSetupDuration,
} from './environment-setup-display';

const statusIcons = {
  starting: Loader2,
  running: Loader2,
  needs_input: CircleHelp,
  verifying: Loader2,
  publish_conflict: TriangleAlert,
  failed: OctagonX,
  published: CheckCircle2,
  reverted: RotateCcw,
  cancelled: XCircle,
} satisfies Record<SetupRunResponse['status'], typeof CheckCircle2>;

type Confirmation = { title: string; description: string; onConfirm: () => Promise<void> };

export function EnvironmentSetupRunCard({
  run,
  organizationId,
}: {
  run: SetupRunResponse;
  organizationId?: string;
}) {
  const access = useEnvironmentSetupEnabled({ organizationId });
  const canManage = access.data?.canStart === true;
  const mutations = useEnvironmentSetupRunMutations();
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const busy = Object.values(mutations).some(mutation => mutation.isPending);
  const input = { organizationId, runId: run.id };
  const act = async (action: () => Promise<unknown>) => {
    if (!canManage || busy) return;
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not update environment setup.');
    }
  };
  const Icon = statusIcons[run.status];
  const stopped = run.agentState?.kind === 'stopped' || run.status === 'failed';
  const canContinue = canContinueEnvironmentSetup(run);
  const reason =
    run.agentState?.kind === 'stopped'
      ? run.agentState.reason
      : (run.statusDetail ?? run.statusReason ?? 'Unknown reason');
  const allowMore = run.statusReason === 'verification_limit_reached';
  const diff = run.diff;
  const verification = run.lastVerification;
  const basePath = organizationId ? `/organizations/${organizationId}/cloud` : '/cloud';
  const cancelButton = (label: string) => (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={() => void act(() => mutations.cancel.mutateAsync(input))}
    >
      {label}
    </Button>
  );
  return (
    <details className="bg-card mx-3 my-2 shrink-0 rounded-lg border text-sm [&_button]:pointer-coarse:min-h-11 [&_summary]:pointer-coarse:min-h-11 sm:mx-4">
      <summary className="focus-visible:ring-ring flex cursor-pointer flex-wrap items-center gap-2 rounded-lg px-3 py-2 outline-none focus-visible:ring-2">
        <span className="font-medium">Environment setup</span>
        <Badge variant="outline" className="gap-1">
          <Icon className="size-3.5" aria-hidden />
          {environmentSetupStatusLabels[run.status]}
        </Badge>
        <span className="text-muted-foreground min-w-0 truncate">
          {run.environmentName ?? 'Draft environment'}
        </span>
      </summary>
      <div className="max-h-[45dvh] space-y-4 overflow-y-auto border-t px-3 py-3">
        {(stopped || canContinue) && (
          <section className="space-y-2">
            <p className="break-words">
              {stopped
                ? `The agent stopped: ${reason}`
                : 'The agent is idle. Select Continue to resume environment setup.'}
            </p>
            {canManage && canContinue && (
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(() =>
                      mutations.resume.mutateAsync({ ...input, raiseVerificationLimit: allowMore })
                    )
                  }
                >
                  {allowMore ? 'Allow more tests' : 'Continue'}
                </Button>
                {cancelButton('Discard')}
              </div>
            )}
          </section>
        )}
        {diff && (
          <section className="space-y-2">
            <h3 className="text-xs font-medium">Changes</h3>
            {formatEnvironmentSetupDiff(diff).length === 0 ? (
              <p className="text-muted-foreground text-xs">No configuration changes.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {formatEnvironmentSetupDiff(diff).map(line => (
                  <li className="break-words" key={line}>
                    {line === 'Setup script changed' ? (
                      <details>
                        <summary className="focus-visible:ring-ring cursor-pointer rounded-sm py-1 outline-none focus-visible:ring-2">
                          {line}
                        </summary>
                        <p className="text-muted-foreground mt-2">Before</p>
                        <pre className="bg-muted max-h-40 overflow-auto rounded p-2">
                          {diff.scriptBefore || '(empty)'}
                        </pre>
                        <p className="text-muted-foreground mt-2">After</p>
                        <pre className="bg-muted max-h-40 overflow-auto rounded p-2">
                          {diff.scriptAfter || '(empty)'}
                        </pre>
                      </details>
                    ) : (
                      line
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
        {(run.pendingVerification || verification) && (
          <section className="space-y-2 border-t pt-3">
            <h3 className="text-xs font-medium">Latest test</h3>
            {run.pendingVerification ? (
              <p role="status">Testing revision {run.pendingVerification.configurationRevision}…</p>
            ) : (
              verification && (
                <>
                  <p>Revision {verification.configurationRevision ?? 'unknown'}</p>
                  <p>
                    {verification.preparation === 'completed'
                      ? `Setup passed${verification.setupDurationMs !== null ? ` in ${formatSetupDuration(verification.setupDurationMs)}` : ''}`
                      : verification.preparation === 'failed'
                        ? `Setup failed: ${verification.preparationError ?? 'Unknown error'}`
                        : verification.preparation === 'running'
                          ? 'Setup is still running.'
                          : 'Setup result is not available.'}
                  </p>
                  <ul className="space-y-2">
                    {verification.checks.map(check => {
                      const result = verification.results.find(
                        result => result.name === check.name
                      );
                      return (
                        <li key={check.name}>
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="break-words">{check.name}</span>
                            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                              {result ? (
                                result.passed ? (
                                  <CheckCircle2 className="size-3.5" aria-hidden />
                                ) : (
                                  <XCircle className="size-3.5" aria-hidden />
                                )
                              ) : (
                                <Clock className="size-3.5" aria-hidden />
                              )}
                              {result ? (result.passed ? 'Passed' : 'Failed') : 'Not reported'}
                            </span>
                          </div>
                          {result && (
                            <details className="mt-1 text-xs">
                              <summary className="focus-visible:ring-ring text-muted-foreground cursor-pointer rounded-sm py-1 outline-none focus-visible:ring-2">
                                Reported by the agent
                              </summary>
                              <pre className="bg-muted max-h-40 overflow-auto rounded p-2 whitespace-pre-wrap break-words">
                                {result.evidence}
                              </pre>
                            </details>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {verification.childKiloSessionId && (
                    <Link
                      className="text-link inline-flex py-1 text-xs underline pointer-coarse:min-h-11 pointer-coarse:items-center"
                      href={`${basePath}/chat?sessionId=${verification.childKiloSessionId}`}
                    >
                      Open test chat
                    </Link>
                  )}
                </>
              )
            )}
          </section>
        )}
        {canManage && (
          <div className="flex flex-wrap gap-2 border-t pt-3">
            {run.status === 'published' ? (
              <>
                {run.canRevert && (
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      setConfirmation({
                        title: run.targetEnvironmentId ? 'Revert' : 'Delete environment',
                        description: run.targetEnvironmentId
                          ? 'Restore the configuration from before this run?'
                          : 'Delete the environment this run created?',
                        onConfirm: async () => {
                          await mutations.revert.mutateAsync(input);
                        },
                      })
                    }
                  >
                    {run.targetEnvironmentId ? 'Revert' : 'Delete environment'}
                  </Button>
                )}
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      await mutations.buildSnapshot.mutateAsync(input);
                    })
                  }
                >
                  Build snapshot now
                </Button>
              </>
            ) : run.status === 'publish_conflict' ? (
              <>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    setConfirmation({
                      title: 'Publish anyway',
                      description:
                        'Overwrite changes made to the environment while the agent worked?',
                      onConfirm: async () => {
                        await mutations.publish.mutateAsync({ ...input, force: true });
                      },
                    })
                  }
                >
                  Publish anyway
                </Button>
                {cancelButton('Discard')}
              </>
            ) : !canContinue && isOpenEnvironmentSetupRun(run.status) ? (
              cancelButton('Cancel')
            ) : null}
          </div>
        )}
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </div>
      {canManage && confirmation && (
        <EnvironmentSetupConfirmDialog {...confirmation} onClose={() => setConfirmation(null)} />
      )}
    </details>
  );
}
