'use client';

import { useId } from 'react';
import { Badge } from '@/components/ui/badge';
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
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 id={headingId} className="text-sm font-medium">
            Transcript display
          </h3>
          <Badge variant="secondary">Personal</Badge>
        </div>
        <p className="text-muted-foreground text-xs">
          Saved in this browser and applied across your personal and organization Cloud Agent chats.
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
