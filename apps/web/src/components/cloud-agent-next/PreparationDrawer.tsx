'use client';

import type { ComponentProps } from 'react';
import { useAtomValue } from 'jotai';
import { AlertCircle, Check, Terminal } from 'lucide-react';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import type {
  PreparationAttempt,
  PreparationStepSnapshot,
  PreparationStepStatus,
} from '@/lib/cloud-agent-sdk';
import { StatusSpinner } from '@/components/shared/StatusSpinner';
import { cn } from '@/lib/utils';
import { useManager } from './CloudAgentProvider';
import { formatAttemptDuration, phaseStatus, phaseStatusLabel } from './preparation-phases';
import { phaseDisplayText } from './preparation-summary';
import { useStickToBottom } from './hooks/useStickToBottom';

type PreparationDrawerProps = {
  attemptId: string | null;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof SheetContent>['onCloseAutoFocus'];
  portalContainer?: HTMLElement | null;
};

/**
 * Slide-out details panel for a preparation attempt. The attempt is looked up
 * from the manager atom by id on every render, so an open drawer keeps
 * streaming step and output updates live.
 */
export function PreparationDrawer({
  attemptId,
  onOpenChange,
  onCloseAutoFocus,
  portalContainer,
}: PreparationDrawerProps) {
  const manager = useManager();
  const attempts = useAtomValue(manager.atoms.preparationAttempts);
  const attempt = attemptId ? attempts.find(candidate => candidate.id === attemptId) : undefined;

  return (
    <Sheet modal={false} open={Boolean(attempt)} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        portalContainer={portalContainer}
        overlayClassName="absolute"
        dismissibleOverlay
        className="absolute inset-y-0 right-0 h-full w-full gap-0 border-l p-0 sm:max-w-xl lg:max-w-2xl"
        onCloseAutoFocus={onCloseAutoFocus}
        onInteractOutside={event => event.preventDefault()}
      >
        <SheetHeader className="shrink-0 border-b pr-14">
          <SheetTitle className="text-base">Environment preparation</SheetTitle>
          <SheetDescription
            className={cn(attempt?.status === 'failed' && 'text-status-destructive')}
          >
            {attempt && attemptSummaryLine(attempt)}
          </SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4 text-xs sm:px-6">
          {attempt && <PreparationTimeline attempt={attempt} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function attemptSummaryLine(attempt: PreparationAttempt): string {
  const title =
    attempt.status === 'running'
      ? 'Preparing environment'
      : attempt.status === 'completed'
        ? 'Environment prepared'
        : 'Preparation failed';
  const duration = formatAttemptDuration(attempt);
  return duration ? `${title} · ${duration}` : title;
}

function PreparationTimeline({ attempt }: { attempt: PreparationAttempt }) {
  const phaseSteps = attempt.steps.filter(step => step.kind === 'phase');
  const commands = attempt.steps.filter(step => step.kind === 'setup_command');
  const commandsUnderPhase = phaseSteps.some(step => step.key === 'setup_commands');
  // A failed command card displays attempt.safeError as its fallback, and a
  // failed phase row displays its own safeError inline — only surface the
  // attempt error separately when no step already carries an error.
  const errorShownOnStep = attempt.steps.some(
    step =>
      step.status === 'failed' && (step.safeError !== undefined || step.kind === 'setup_command')
  );

  return (
    <>
      <ol className="flex flex-col">
        {phaseSteps.map(step => (
          <PhaseRow key={step.id} step={step} status={phaseStatus(step, commands)}>
            {step.key === 'setup_commands' && commands.length > 0 && (
              <CommandList commands={commands} attemptError={attempt.safeError} />
            )}
          </PhaseRow>
        ))}
      </ol>

      {!commandsUnderPhase && commands.length > 0 && (
        <div className="mt-4">
          <p className="type-label mb-2 text-muted-foreground">Setup commands</p>
          <CommandList commands={commands} attemptError={attempt.safeError} />
        </div>
      )}

      {attempt.safeError && !errorShownOnStep && (
        <p className="mt-3 text-status-destructive">{attempt.safeError}</p>
      )}
    </>
  );
}

function PhaseRow({
  step,
  status,
  children,
}: {
  step: PreparationStepSnapshot;
  status: PreparationStepStatus;
  children?: React.ReactNode;
}) {
  const duration = formatAttemptDuration(step);

  return (
    <li className="border-b border-border py-2 last:border-b-0">
      <div className="flex min-h-6 items-center gap-2">
        <span
          className={cn(
            'grid size-5 shrink-0 place-items-center rounded-full',
            status === 'running' && 'border border-border-strong text-muted-foreground',
            status === 'completed' && 'text-status-success-icon',
            status === 'failed' && 'border border-destructive text-status-destructive-icon'
          )}
          aria-hidden="true"
        >
          <PhaseIcon status={status} />
        </span>
        <span
          className={cn(
            'min-w-0 truncate text-foreground',
            status === 'failed' && 'text-status-destructive'
          )}
        >
          {phaseDisplayText(step)}
        </span>
        <span className="sr-only">{phaseStatusLabel(status)}</span>
        {duration && (
          <span className="ml-auto shrink-0 text-foreground-subtle tabular-nums">{duration}</span>
        )}
      </div>
      {step.safeError && <p className="ml-7 mt-0.5 text-status-destructive">{step.safeError}</p>}
      {children && <div className="ml-7 mt-2">{children}</div>}
    </li>
  );
}

function PhaseIcon({ status }: { status: PreparationStepStatus }) {
  if (status === 'running') return <StatusSpinner className="size-3" />;
  if (status === 'completed') return <Check className="size-3" />;
  return <AlertCircle className="size-3" />;
}

function CommandList({
  commands,
  attemptError,
}: {
  commands: readonly PreparationStepSnapshot[];
  attemptError?: string;
}) {
  return (
    <ol className="flex flex-col gap-2">
      {commands.map(command => (
        <li key={command.id}>
          <CommandCard
            step={command}
            fallbackError={command.status === 'failed' ? attemptError : undefined}
          />
        </li>
      ))}
    </ol>
  );
}

function CommandCard({
  step,
  fallbackError,
}: {
  step: PreparationStepSnapshot;
  fallbackError?: string;
}) {
  const error = step.safeError ?? fallbackError;
  const output = useStickToBottom<HTMLPreElement>(step.outputTail);

  return (
    <div
      className={cn(
        'overflow-hidden rounded-lg border border-border bg-surface-inset',
        step.status === 'failed' && 'border-status-destructive-border'
      )}
    >
      <div
        className={cn(
          'flex min-h-10 items-center gap-2 border-b border-border px-3 py-2',
          step.status === 'failed' &&
            'border-status-destructive-border bg-status-destructive-surface'
        )}
      >
        <CommandIcon status={step.status} />
        <code className="min-w-0 break-words font-mono text-foreground">
          {step.command ?? step.label}
        </code>
        <span
          className={cn(
            'ml-auto shrink-0 text-muted-foreground tabular-nums',
            step.status === 'failed' && 'text-status-destructive'
          )}
        >
          {commandStatus(step)}
        </span>
      </div>
      {error && (
        <p className="border-b border-status-destructive-border px-3 py-2 text-status-destructive">
          {error}
        </p>
      )}
      {step.outputTail && (
        <div role={step.status === 'running' ? 'log' : undefined} aria-label="Command output">
          <div className="flex min-h-8 items-center justify-between gap-3 px-3 py-1.5 text-foreground-subtle">
            <span>Command output</span>
            {step.outputTruncated && <span>Earlier output omitted</span>}
          </div>
          <pre
            ref={output.ref}
            onScroll={output.onScroll}
            className="max-h-64 overflow-auto px-3 pb-3 font-mono text-[11px] leading-5 whitespace-pre text-syntax-plain"
          >
            {step.outputTail}
          </pre>
        </div>
      )}
    </div>
  );
}

function commandStatus(step: PreparationStepSnapshot): string {
  if (step.status === 'running') return 'Running';
  const status = step.status === 'failed' ? 'Failed' : 'Completed';
  return step.exitCode === undefined ? status : `${status}, exit ${step.exitCode}`;
}

function CommandIcon({ status }: { status: PreparationStepSnapshot['status'] }) {
  if (status === 'running') return <StatusSpinner className="size-icon-sm shrink-0" />;
  if (status === 'failed') {
    return <AlertCircle className="size-icon-sm shrink-0 text-status-destructive-icon" />;
  }
  return <Terminal className="size-icon-sm shrink-0 text-foreground-subtle" />;
}
