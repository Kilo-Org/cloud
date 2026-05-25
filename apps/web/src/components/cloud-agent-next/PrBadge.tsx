'use client';

import { forwardRef } from 'react';
import {
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

import {
  normalizePrBadgeState,
  prAccentColor,
  type AssociatedPr,
  type PrBadgeState,
  type ReviewDecision,
} from './utils/github-pr-link';

function resolveIcon(state: PrBadgeState, reviewDecision: ReviewDecision | null): LucideIcon {
  if (state === 'merged') return GitMerge;
  if (state === 'closed') return GitPullRequestClosed;
  if (state === 'draft') return GitPullRequestDraft;
  // open state: use review-decision icon when available
  if (reviewDecision === 'approved') return CircleCheck;
  if (reviewDecision === 'changes_requested') return CircleX;
  return GitPullRequest;
}

const STATE_ARIA_LABELS: Record<PrBadgeState, string> = {
  open: 'open pull request',
  merged: 'merged pull request',
  closed: 'closed pull request',
  draft: 'draft pull request',
};

type PrBadgeProps = {
  pr: AssociatedPr;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children' | 'aria-label'>;

/**
 * Compact pill that summarizes the PR associated with a session row.
 *
 * Visual mapping:
 *   - `open` + approved          → emerald + CircleCheck
 *   - `open` + changes_requested → amber   + CircleX
 *   - `open` + review_required   → emerald + GitPullRequest
 *   - `open` + no decision       → emerald + GitPullRequest
 *   - `draft`                    → zinc    + GitPullRequestDraft
 *   - `merged`                   → violet  + GitMerge
 *   - `closed`                   → red     + GitPullRequestClosed
 */
export const PrBadge = forwardRef<HTMLButtonElement, PrBadgeProps>(function PrBadge(
  { pr, className, style, ...rest },
  ref
) {
  const state = normalizePrBadgeState(pr.state);
  const Icon = resolveIcon(state, pr.reviewDecision ?? null);
  const accent = prAccentColor(state, pr.reviewDecision ?? null);

  return (
    <button
      ref={ref}
      type="button"
      aria-label={`${STATE_ARIA_LABELS[state]} #${pr.number}`}
      {...rest}
      style={{
        color: accent,
        ...style,
      }}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md bg-[color-mix(in_oklch,currentColor_20%,transparent)] py-0.5 pr-1.5 pl-1 text-[11px] font-medium tabular-nums transition-colors hover:bg-[color-mix(in_oklch,currentColor_25%,transparent)] focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
        className
      )}
    >
      <Icon className="h-3 w-3" aria-hidden="true" />
      <span>#{pr.number}</span>
    </button>
  );
});

/**
 * Placeholder shown while the parent has no `associatedPr` field yet (e.g.
 * during the first list query render). The fixed width avoids layout shift
 * when the badge resolves.
 *
 * The 300ms animation delay matches the kilocode Agent Manager pattern: brief
 * loads never flash a skeleton.
 */
export function PrBadgeSkeleton() {
  return (
    <span
      aria-hidden="true"
      className="bg-muted inline-block h-3.5 w-[52px] shrink-0 animate-pulse rounded-md"
      style={{ animationDelay: '300ms' }}
    />
  );
}
