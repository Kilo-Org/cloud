'use client';

import { ChevronDown } from 'lucide-react';
import { CopyMessageButton } from '@/components/shared/CopyMessageButton';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { TextPartRenderer } from './part-content';

export function CompactionSummary({ text }: { text?: string }) {
  return (
    <div className="space-y-2 py-2">
      <p className="text-muted-foreground text-xs">
        Compaction replaces older model context with a summary. The agent uses it to continue this
        chat.
      </p>
      {text ? (
        <Collapsible defaultOpen className="border-border rounded-md border">
          <div className="flex items-center pr-2">
            <CollapsibleTrigger className="group hover:bg-muted/40 focus-visible:ring-ring flex min-h-11 min-w-0 flex-1 items-center gap-2 rounded-md px-3 py-2 text-left text-sm focus-visible:ring-2 focus-visible:outline-none">
              <ChevronDown
                className="text-muted-foreground size-4 shrink-0 transition-transform group-data-[state=closed]:-rotate-90 motion-reduce:transition-none"
                aria-hidden
              />
              Context summary
            </CollapsibleTrigger>
            <CopyMessageButton getText={() => text} label="Copy summary" />
          </div>
          <CollapsibleContent
            role="region"
            aria-label="Context summary"
            tabIndex={0}
            className="border-border focus-visible:ring-ring max-h-[min(24rem,50vh)] overflow-y-auto overscroll-y-contain border-t px-3 py-2 focus-visible:ring-2 focus-visible:ring-inset focus-visible:outline-none"
          >
            <TextPartRenderer text={text} isStreaming={false} />
          </CollapsibleContent>
        </Collapsible>
      ) : (
        <p className="text-muted-foreground text-xs">
          No summary is available for this compaction.
        </p>
      )}
    </div>
  );
}
