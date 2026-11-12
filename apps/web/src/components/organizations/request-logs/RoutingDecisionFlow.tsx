import type { ReactNode } from 'react';
import { CircleCheck, CircleMinus, CircleX, Clock, Flag, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  requestNotSentReason,
  type RequestLogByokCandidate,
  type RequestLogByokFailoverAttempt,
  type RequestLogRoutingDetails,
  type RequestLogRoutingStep,
} from '@/lib/request-logs/routing-details';
import { TONE_CLASSNAMES, ToneBadge } from './detail-primitives';
import { getByokProviderDisplayName } from '@/lib/byok/provider-names';
import {
  byokOutcomeLabel,
  byokSkipReasonLabel,
  describeResult,
  describeStep,
  describeUnsentResult,
  inferenceProviderNames,
  rejectedResultLabel,
  type StepTone,
} from './routing-labels';

const TONE_ICONS: Record<StepTone, typeof CircleCheck> = {
  selected: CircleCheck,
  skipped: CircleMinus,
  rejected: CircleX,
  deferred: Clock,
  info: Info,
};

const TONE_LABELS: Record<StepTone, string> = {
  selected: 'Selected',
  skipped: 'Skipped',
  rejected: 'Rejected',
  deferred: 'Deferred',
  info: 'Applied',
};

function byokOutcomeTone(outcome: string): StepTone {
  if (outcome === 'selected' || outcome === 'skipped') return outcome;
  if (outcome === 'failed') return 'rejected';
  return 'info';
}

/** The routing decision predates failover, so the attempts decide which keys failed or served. */
function withFailoverOutcomes(
  candidates: RequestLogByokCandidate[],
  attempts: RequestLogByokFailoverAttempt[]
): RequestLogByokCandidate[] {
  if (attempts.length === 0) return candidates;
  const outcomes = new Map<string, string>();
  for (const attempt of attempts) {
    for (const providerId of attempt.byok_provider_ids) {
      outcomes.set(providerId, attempt.outcome === 'served' ? 'selected' : 'failed');
    }
  }
  return candidates.map(candidate => {
    const outcome = outcomes.get(candidate.provider_id);
    return outcome ? { ...candidate, outcome } : candidate;
  });
}

function FlowNode({
  tone,
  icon: Icon,
  isLast,
  children,
}: {
  tone: StepTone;
  icon: typeof CircleCheck;
  isLast: boolean;
  children: ReactNode;
}) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0">
      {!isLast && (
        <span aria-hidden="true" className="bg-border absolute top-7 bottom-0 left-3.5 w-px" />
      )}
      <span
        aria-hidden="true"
        className={cn(
          'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full border',
          TONE_CLASSNAMES[tone]
        )}
      >
        <Icon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1.5 pt-0.5">{children}</div>
    </li>
  );
}

function ByokCandidates({ candidates }: { candidates: RequestLogByokCandidate[] }) {
  const ordered = [...candidates].sort(
    (a, b) => (a.route_order ?? Infinity) - (b.route_order ?? Infinity)
  );
  return (
    <ol className="flex flex-col gap-1 rounded-md border p-2" aria-label="BYOK keys in route order">
      {ordered.map((candidate, index) => (
        <li
          key={`${candidate.route}-${candidate.provider_id}-${index}`}
          className="flex flex-wrap items-center gap-2 text-xs"
        >
          <span className="text-muted-foreground w-5 text-right tabular-nums">{index + 1}.</span>
          <span className="font-medium">{getByokProviderDisplayName(candidate.provider_id)}</span>
          {candidate.route === 'vercel-byok' && (
            <span className="text-muted-foreground">via Vercel AI Gateway</span>
          )}
          <ToneBadge tone={byokOutcomeTone(candidate.outcome)}>
            {byokOutcomeLabel(candidate.outcome)}
          </ToneBadge>
          {candidate.reason && (
            <span className="text-muted-foreground">{byokSkipReasonLabel(candidate.reason)}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

function KiloStepDetails({ step }: { step: RequestLogRoutingStep }) {
  const notes = [
    step.bounded_spending ? 'Bounded spending' : null,
    step.organization_disabled_vercel_ai_gateway
      ? 'Vercel AI Gateway turned off by the organization'
      : null,
  ].filter(note => note !== null);
  const ignored = step.kilo_ignored_providers ?? [];
  if (notes.length === 0 && ignored.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5">
      {notes.map(note => (
        <ToneBadge key={note} tone="info">
          {note}
        </ToneBadge>
      ))}
      {ignored.length > 0 && (
        <span className="text-muted-foreground text-xs">
          Providers ignored by Kilo:{' '}
          <span className="text-foreground">{inferenceProviderNames(ignored)}</span>
        </span>
      )}
    </div>
  );
}

function failoverStopLabels(stopReason: string | undefined): { title: string; detail: string } {
  switch (stopReason) {
    case 'budget-exhausted':
      return {
        title: 'BYOK failover ran out of time',
        detail: 'Too little time was left to try another key, so the last error was returned.',
      };
    case 'model-unavailable':
      return {
        title: 'BYOK failover reached a gateway that does not list this model',
        detail: 'No further keys were tried, and the model-not-found error was returned.',
      };
    case 'client-disconnected':
      return {
        title: 'The client disconnected during BYOK failover',
        detail: 'No further keys were tried.',
      };
    default:
      return {
        title: 'Every BYOK key that could serve the request failed',
        detail: "The last key's error was returned.",
      };
  }
}

function FailoverNote({ attempts }: { attempts: RequestLogByokFailoverAttempt[] }) {
  const failed = attempts.filter(attempt => attempt.outcome !== 'served').length;
  return (
    <p className="text-muted-foreground text-xs">
      {failed === 1 ? '1 BYOK key failed' : `${failed} BYOK keys failed`} before this attempt. See
      BYOK failover.
    </p>
  );
}

function ResultNode({ routing }: { routing: RequestLogRoutingDetails }) {
  const result = routing.result;
  const attempts = routing.byok_failover_attempts;
  const finalAttempt = attempts.at(-1);
  if (!result) {
    return (
      <FlowNode tone="info" icon={Flag} isLast>
        <span className="text-sm font-medium">Result not recorded</span>
      </FlowNode>
    );
  }
  if (result.kind !== 'provider') {
    return (
      <FlowNode tone="rejected" icon={Flag} isLast>
        <span className="text-sm font-medium">{rejectedResultLabel(result)}</span>
      </FlowNode>
    );
  }
  const notSentReason = requestNotSentReason(routing);
  if (notSentReason) {
    const { title, detail } = describeUnsentResult(result, notSentReason);
    return (
      <FlowNode tone="rejected" icon={Flag} isLast>
        <span className="text-sm font-medium">{title}</span>
        {detail && <p className="text-muted-foreground text-xs">{detail}</p>}
      </FlowNode>
    );
  }
  if (finalAttempt?.outcome === 'failed') {
    const stopped = failoverStopLabels(finalAttempt.stop_reason);
    return (
      <FlowNode tone="rejected" icon={Flag} isLast>
        <span className="text-sm font-medium">{stopped.title}</span>
        <p className="text-muted-foreground text-xs">
          {stopped.detail} Kilo credits were not used. See BYOK failover.
        </p>
      </FlowNode>
    );
  }
  const { title, paidBy } = describeResult(
    finalAttempt
      ? {
          ...result,
          provider_type: finalAttempt.provider_type ?? result.provider_type,
          byok_provider_ids: finalAttempt.byok_provider_ids,
        }
      : result
  );
  return (
    <FlowNode tone="selected" icon={Flag} isLast>
      <span className="text-sm font-medium">{title}</span>
      {paidBy && (
        <p className="text-muted-foreground text-xs">
          Paid by: <span className="text-foreground">{paidBy}</span>
        </p>
      )}
      {finalAttempt && <FailoverNote attempts={attempts} />}
    </FlowNode>
  );
}

export function RoutingDecisionFlow({ routing }: { routing: RequestLogRoutingDetails }) {
  const byokStepIndex = routing.steps.findIndex(step => step.step === 'byok-key');
  const candidates = withFailoverOutcomes(routing.byok_candidates, routing.byok_failover_attempts);
  const showCandidatesSeparately = byokStepIndex === -1 && candidates.length > 0;
  const failedOver = routing.byok_failover_attempts.length > 0;

  return (
    <ol className="flex flex-col" aria-label="Provider selection steps">
      {routing.steps.map((step, index) => {
        const described = describeStep(step, { failedOver });
        return (
          <FlowNode
            key={`${step.step}-${index}`}
            tone={described.tone}
            icon={TONE_ICONS[described.tone]}
            isLast={false}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium">{described.title}</span>
              <ToneBadge tone={described.tone}>{TONE_LABELS[described.tone]}</ToneBadge>
            </div>
            {described.detail && (
              <p className="text-muted-foreground text-xs">{described.detail}</p>
            )}
            {index === byokStepIndex && candidates.length > 0 && (
              <ByokCandidates candidates={candidates} />
            )}
            {step.step === 'kilo' && <KiloStepDetails step={step} />}
          </FlowNode>
        );
      })}
      {showCandidatesSeparately && (
        <FlowNode tone="info" icon={Info} isLast={false}>
          <span className="text-sm font-medium">BYOK keys</span>
          <ByokCandidates candidates={candidates} />
        </FlowNode>
      )}
      <ResultNode routing={routing} />
    </ol>
  );
}
