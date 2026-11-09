'use client';

import { useId } from 'react';
import { Monitor } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useCollapseToolsPreference } from '../collapse-tools-preference';
import { SettingHint } from './SettingHint';

export function TranscriptPreferencesSection() {
  const headingId = useId();
  const collapseToolsId = useId();
  const { collapseTools, setCollapseTools } = useCollapseToolsPreference();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h4 id={headingId} className="text-sm font-medium">
          Display
        </h4>
        <Badge variant="outline" className="text-muted-foreground">
          <Monitor aria-hidden />
          This browser
        </Badge>
      </div>
      <div className="flex min-h-13 items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
        <div className="flex min-w-0 items-center gap-1">
          <Label htmlFor={collapseToolsId} className="pointer-coarse:min-h-11">
            Collapse tool calls
          </Label>
          <SettingHint label="Collapse tool calls">
            Groups tool calls and reasoning between messages into one row you can expand.
          </SettingHint>
        </div>
        <Switch id={collapseToolsId} checked={collapseTools} onCheckedChange={setCollapseTools} />
      </div>
    </section>
  );
}
