'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Loader2, Users } from 'lucide-react';
import type { CodeReviewCouncilResult, CouncilVote } from '@kilocode/db/schema-types';
import { formatAggregationStrategy } from '@kilocode/worker-utils/code-review-council';

const VOTE_LABELS: Record<CouncilVote, string> = {
  pass: 'Pass',
  warn: 'Warn',
  block: 'Block',
  abstain: 'Abstain',
};

// Map council votes onto the app's status-domain surface/border/foreground tokens.
const VOTE_CLASSES: Record<CouncilVote, string> = {
  pass: 'bg-status-success-surface text-status-success border-status-success-border',
  warn: 'bg-status-warning-surface text-status-warning border-status-warning-border',
  block: 'bg-status-destructive-surface text-status-destructive border-status-destructive-border',
  abstain: 'bg-status-neutral-surface text-status-neutral border-status-neutral-border',
};

function VoteBadge({ vote }: { vote: CouncilVote }) {
  return (
    <Badge className={VOTE_CLASSES[vote]} aria-label={`Vote: ${VOTE_LABELS[vote]}`}>
      {VOTE_LABELS[vote]}
    </Badge>
  );
}

type CouncilGovernancePanelProps = {
  /** Persisted council outcome; null until the run has completed and been captured. */
  councilResult: CodeReviewCouncilResult | null;
  /** True when this is a council run that is still in flight (no result yet). */
  awaitingResults?: boolean;
};

/**
 * Read-only council results for the review detail screen: the code-owned governance
 * decision plus each specialist's model, vote, and findings. Consumes the persisted
 * `CodeReviewCouncilResult` directly.
 */
export function CouncilGovernancePanel({
  councilResult,
  awaitingResults = false,
}: CouncilGovernancePanelProps) {
  const totalFindings =
    councilResult?.specialists.reduce((sum, s) => sum + s.findings.length, 0) ?? 0;

  return (
    <Card>
      <CardHeader className="gap-2 sm:flex-row sm:items-center sm:justify-between">
        <CardTitle className="flex items-center gap-2">
          <Users className="h-5 w-5" />
          Council review
        </CardTitle>
        {councilResult ? <VoteBadge vote={councilResult.decision} /> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {!councilResult ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            {awaitingResults && <Loader2 className="h-4 w-4 animate-spin" />}
            {awaitingResults
              ? 'Specialists are reviewing. Results will appear when the council completes.'
              : 'No council result was captured for this run.'}
          </p>
        ) : (
          <>
            <div className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-sm">
              <span>{councilResult.specialists.length} specialists</span>
              <span>{formatAggregationStrategy(councilResult.aggregationStrategy)}</span>
              <span>
                {totalFindings} {totalFindings === 1 ? 'finding' : 'findings'}
              </span>
            </div>

            {/*
              PR4: the decision above is an advisory pass/fail score only — it is surfaced
              here but does not (yet) block the pull request merge. Keep in sync with the
              TODO(council) note in finalize-council-result.ts.
            */}
            <p className="text-muted-foreground text-xs">
              This is an advisory pass/fail score and does not block the pull request yet.
            </p>

            <ul className="divide-border divide-y">
              {councilResult.specialists.map(specialist => (
                <li key={specialist.id} className="space-y-2 py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{specialist.name}</span>
                        <VoteBadge vote={specialist.vote} />
                      </div>
                      <p className="text-muted-foreground text-xs">
                        {specialist.model ?? 'Default model'}
                        {specialist.thinkingEffort ? ` · ${specialist.thinkingEffort}` : ''}
                        {specialist.highestSeverity ? ` · ${specialist.highestSeverity}` : ''}
                      </p>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {specialist.findings.length}{' '}
                      {specialist.findings.length === 1 ? 'finding' : 'findings'}
                    </span>
                  </div>

                  {specialist.findings.length > 0 && (
                    <ul className="space-y-1.5">
                      {specialist.findings.map((finding, index) => (
                        <li
                          key={`${specialist.id}-${index}`}
                          className="bg-surface-inset rounded-md p-2 text-sm"
                        >
                          <div className="flex items-center gap-2 font-mono text-xs">
                            <span className="text-muted-foreground">
                              {finding.path}
                              {typeof finding.line === 'number' ? `:${finding.line}` : ''}
                            </span>
                            <span className="text-muted-foreground">·</span>
                            <span>{finding.severity}</span>
                          </div>
                          <p className="mt-1">{finding.rationale}</p>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
