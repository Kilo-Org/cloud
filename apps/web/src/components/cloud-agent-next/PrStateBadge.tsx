'use client';

import { prAccentColor, type PrBadgeState } from './utils/github-pr-link';

const LABELS: Record<PrBadgeState, string> = {
  open: 'open',
  merged: 'merged',
  closed: 'closed',
  draft: 'draft',
};

export function PrStateBadge({ state }: { state: PrBadgeState }) {
  const accent = prAccentColor(state, null);
  return (
    <span
      style={{
        backgroundColor: `color-mix(in oklch, ${accent} 20%, transparent)`,
        color: accent,
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded px-2 py-0.5 text-xs font-medium"
    >
      {LABELS[state]}
    </span>
  );
}
