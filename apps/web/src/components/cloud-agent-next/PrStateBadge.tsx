'use client';

import type { PrBadgeState } from './utils/github-pr-link';

const STYLES: Record<PrBadgeState, string> = {
  open: 'bg-emerald-500/20 text-emerald-400',
  merged: 'bg-purple-500/20 text-purple-400',
  closed: 'bg-zinc-500/20 text-zinc-400',
};

const LABELS: Record<PrBadgeState, string> = {
  open: 'open',
  merged: 'merged',
  closed: 'closed',
};

export function PrStateBadge({ state }: { state: PrBadgeState }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs font-medium ${STYLES[state]}`}
    >
      {LABELS[state]}
    </span>
  );
}
