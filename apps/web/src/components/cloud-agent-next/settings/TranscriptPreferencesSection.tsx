'use client';

import { useId } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useCollapseToolsPreference } from '../collapse-tools-preference';

export function TranscriptPreferencesSection() {
  const headingId = useId();
  const collapseToolsId = useId();
  const collapseToolsDescriptionId = useId();
  const { collapseTools, setCollapseTools } = useCollapseToolsPreference();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h4 id={headingId} className="text-sm font-medium">
          Transcript display
        </h4>
        <p className="text-muted-foreground text-xs">
          Display preferences are saved in this browser.
        </p>
      </div>
      <div className="flex items-start justify-between gap-4 rounded-lg border px-3 py-2.5">
        <div className="flex min-w-0 flex-col gap-1">
          <Label htmlFor={collapseToolsId} className="pointer-coarse:min-h-11">
            Collapse tools
          </Label>
          <p id={collapseToolsDescriptionId} className="text-muted-foreground text-xs">
            Group tool calls and reasoning between messages into one expandable row.
          </p>
        </div>
        <Switch
          id={collapseToolsId}
          checked={collapseTools}
          onCheckedChange={setCollapseTools}
          aria-describedby={collapseToolsDescriptionId}
        />
      </div>
    </section>
  );
}
