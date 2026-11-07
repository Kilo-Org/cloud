import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Styles for the context row under the new-session composer. One group draws a single border
 * around adjacent segments: repository with its stack base, and environment with profile.
 * The group's direct children must be the segments; dialogs and popovers render in portals.
 * Groups and segments keep their automatic minimum width, so a squeezed segment keeps its icons
 * and buttons visible. Put shrinkable text in `SegmentText`.
 */
export const contextGroupClassName =
  'inline-flex h-7 max-w-full items-stretch divide-x divide-border/50 overflow-hidden rounded-md border border-border/50 bg-muted/30 text-xs';

export const contextSegmentClassName = 'inline-flex items-center gap-1.5 whitespace-nowrap px-2';

export const interactiveContextSegmentClassName =
  'text-muted-foreground cursor-pointer transition-colors hover:bg-muted/60 hover:text-foreground focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none';

/**
 * Segment text that truncates with an ellipsis. The grid track gives it a minimum width of zero.
 * A plain `truncate` element reports its full text as its minimum width, so its segment could not
 * shrink without clipping its other content.
 */
export function SegmentText({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <span className={cn('inline-grid grid-cols-[minmax(0,max-content)]', className)}>
      <span className="truncate">{children}</span>
    </span>
  );
}
