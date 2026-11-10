'use client';

import { type ReactNode } from 'react';
import { ChevronDown, LoaderCircle } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';

export function AgentWorkGroup({
  summary,
  working = false,
  activity,
  children,
}: {
  summary: string;
  working?: boolean;
  activity?: string;
  children: ReactNode;
}) {
  return (
    <Collapsible className="border-muted bg-muted/30 rounded-md border">
      <CollapsibleTrigger className="group hover:bg-muted/40 focus-visible:ring-ring flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none">
        {working && (
          <LoaderCircle
            className="text-muted-foreground size-4 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden
          />
        )}
        <span className="text-muted-foreground flex min-w-0 flex-1 items-baseline gap-2 text-sm">
          <span className="max-w-full shrink-0 truncate">{summary}</span>
          {activity && (
            <span className="min-w-0 truncate font-mono text-xs" title={activity}>
              {activity}
            </span>
          )}
        </span>
        <ChevronDown
          className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=open]:rotate-180 motion-reduce:transition-none"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="border-muted space-y-2 border-t px-3 py-2">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
