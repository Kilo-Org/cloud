import type { ReactNode } from 'react';
import { CircleCheck, CircleMinus, CircleX, Clock, Flag, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import type {
  RequestLogByokCandidate,
  RequestLogRoutingDetails,
  RequestLogRoutingStep,
} from '@/lib/request-logs/routing-details';
import { TONE_CLASSNAMES, ToneBadge } from './detail-primitives';
import {
  byokOutcomeLabel,
  byokSkipReasonLabel,
  describeStep,
  payerLabel,
  providerTypeLabel,
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
  return 'info';
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
          <span className="font-mono">{candidate.provider_id}</span>
          <span className="text-muted-foreground">{candidate.route}</span>
          {candidate.priority != null && (
            <span className="text-muted-foreground">priority {candidate.priority}</span>
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
          Providers ignored by Kilo: <span className="font-mono">{ignored.join(', ')}</span>
        </span>
      )}
    </div>
  );
}

function ResultNode({ routing }: { routing: RequestLogRoutingDetails }) {
  const result = routing.result;
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
  return (
    <FlowNode tone="selected" icon={Flag} isLast>
      <span className="text-sm font-medium">
        {result.provider_type ? providerTypeLabel(result.provider_type) : 'Provider selected'}
      </span>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {result.route && (
          <span>
            Route: <span className="text-foreground font-mono">{result.route}</span>
          </span>
        )}
        {result.payer && (
          <span>
            Paid by: <span className="text-foreground">{payerLabel(result.payer)}</span>
          </span>
        )}
        {result.byok_provider_ids && result.byok_provider_ids.length > 0 && (
          <span>
            BYOK keys:{' '}
            <span className="text-foreground font-mono">{result.byok_provider_ids.join(', ')}</span>
          </span>
        )}
        {result.is_free && <span className="text-foreground">Free</span>}
      </div>
    </FlowNode>
  );
}

export function RoutingDecisionFlow({ routing }: { routing: RequestLogRoutingDetails }) {
  const byokStepIndex = routing.steps.findIndex(step => step.step === 'byok-key');
  const showCandidatesSeparately = byokStepIndex === -1 && routing.byok_candidates.length > 0;

  return (
    <ol className="flex flex-col" aria-label="Provider selection steps">
      {routing.steps.map((step, index) => {
        const described = describeStep(step);
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
            {index === byokStepIndex && routing.byok_candidates.length > 0 && (
              <ByokCandidates candidates={routing.byok_candidates} />
            )}
            {step.step === 'kilo' && <KiloStepDetails step={step} />}
          </FlowNode>
        );
      })}
      {showCandidatesSeparately && (
        <FlowNode tone="info" icon={Info} isLast={false}>
          <span className="text-sm font-medium">BYOK keys</span>
          <ByokCandidates candidates={routing.byok_candidates} />
        </FlowNode>
      )}
      <ResultNode routing={routing} />
    </ol>
  );
}
