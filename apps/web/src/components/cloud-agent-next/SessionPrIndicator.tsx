'use client';

import { useCallback } from 'react';

import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';

import { PrBadge, PrBadgeSkeleton } from './PrBadge';
import { PrHoverCardContent } from './PrHoverCardContent';
import type { StoredSession } from './types';

type SessionPrIndicatorProps = {
  session: Pick<StoredSession, 'sessionId' | 'branch' | 'associatedPr' | 'repository'>;
};

/**
 * Right-aligned PR indicator for a single session row in the sidebar.
 *
 * Tri-state behavior driven by `session.associatedPr`:
 *   - `undefined` + the session has a `branch` → render a fixed-width skeleton
 *     so the column does not jitter while the list query is in flight.
 *   - `null` → render nothing (server confirmed the session has no PR).
 *   - `AssociatedPr` → render the badge wrapped in a hover card; clicking the
 *     badge opens the PR on GitHub and `stopPropagation` prevents the row's
 *     own click handler from selecting the session.
 */
export function SessionPrIndicator({ session }: SessionPrIndicatorProps) {
  const handleBadgeClick = useCallback(
    (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      const url = session.associatedPr?.url;
      if (!url) return;
      window.open(url, '_blank', 'noopener,noreferrer');
    },
    [session.associatedPr]
  );

  if (session.associatedPr === undefined) {
    if (!session.branch) return null;
    return <PrBadgeSkeleton />;
  }

  if (session.associatedPr === null) {
    return null;
  }

  const pr = session.associatedPr;

  return (
    <HoverCard openDelay={120} closeDelay={80}>
      <HoverCardTrigger asChild>
        <PrBadge pr={pr} onClick={handleBadgeClick} />
      </HoverCardTrigger>
      <HoverCardContent
        align="end"
        side="left"
        className="w-72"
        onClick={event => event.stopPropagation()}
      >
        <PrHoverCardContent
          pr={pr}
          sessionId={session.sessionId}
          gitBranch={session.branch ?? null}
        />
      </HoverCardContent>
    </HoverCard>
  );
}
