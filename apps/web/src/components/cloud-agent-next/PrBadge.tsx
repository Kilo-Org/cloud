'use client';

import { forwardRef } from 'react';
import {
  CircleCheck,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  type LucideIcon,
} from 'lucide-react';

import { cn } from '@/lib/utils';

import {
  normalizePrBadgeState,
  type AssociatedPr,
  type PrBadgeState,
  type ReviewDecision,
} from './utils/github-pr-link';

const STATE_CLASSES: Record<PrBadgeState, string> = {
  open: 'bg-zinc-500/20 text-zinc-400 hover:bg-zinc-500/25',
  merged: 'bg-purple-500/20 text-purple-400 hover:bg-purple-500/25',
  closed: 'bg-zinc-500/20 text-zinc-400 hover:bg-zinc-500/25',
};

function resolveClasses(state: PrBadgeState, reviewDecision: ReviewDecision | null): string {
  if (state === 'open') {
    if (reviewDecision === 'approved')
      return 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/25';
    if (reviewDecision === 'changes_requested')
      return 'bg-amber-500/20 text-amber-400 hover:bg-amber-500/25';
  }
  return STATE_CLASSES[state];
}

function resolveIcon(state: PrBadgeState, reviewDecision: ReviewDecision | null): LucideIcon {
  if (state === 'merged') return GitMerge;
  if (state === 'closed') return GitPullRequestClosed;
  // open state: use review-decision icon when available
  if (reviewDecision === 'approved') return CircleCheck;
  if (reviewDecision === 'changes_requested') return CircleX;
  return GitPullRequest;
}

const STATE_ARIA_LABELS: Record<PrBadgeState, string> = {
  open: 'open pull request',
  merged: 'merged pull request',
  closed: 'closed pull request',
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
 *   - `open` + review_required   → zinc    + GitPullRequest
 *   - `open` + no decision       → zinc    + GitPullRequest
 *   - `merged`                   → purple  + GitMerge
 *   - `closed`                   → zinc    + GitPullRequestClosed (icon distinguishes from open)
 */
export const PrBadge = forwardRef<HTMLButtonElement, PrBadgeProps>(function PrBadge(
  { pr, className, ...rest },
  ref
) {
  const state = normalizePrBadgeState(pr.state);
  const Icon = resolveIcon(state, pr.reviewDecision ?? null);
  const classes = resolveClasses(state, pr.reviewDecision ?? null);

  return (
    <button
      ref={ref}
      type="button"
      aria-label={`${STATE_ARIA_LABELS[state]} #${pr.number}`}
      {...rest}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-md py-0.5 pr-1.5 pl-1 text-[11px] font-medium tabular-nums transition-colors focus-visible:ring-1 focus-visible:ring-ring focus-visible:outline-none',
        classes,
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
