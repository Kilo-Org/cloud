'use client';

import { useId } from 'react';
import { Monitor } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useSoundNotificationsPreference } from '@/hooks/useCelebrationSound';

export function SoundPreferencesSection() {
  const headingId = useId();
  const soundId = useId();
  const descriptionId = useId();
  const [soundEnabled, setSoundEnabled] = useSoundNotificationsPreference();

  return (
    <section aria-labelledby={headingId} className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <h4 id={headingId} className="text-sm font-medium">
          Sound
        </h4>
        <Badge variant="outline" className="text-muted-foreground">
          <Monitor aria-hidden />
          This browser
        </Badge>
      </div>
      <div className="flex min-h-13 items-center justify-between gap-4 rounded-lg border px-3 py-2.5">
        <div className="min-w-0 space-y-1">
          <Label htmlFor={soundId}>Completion sound</Label>
          <p id={descriptionId} className="text-muted-foreground text-sm">
            Play a sound when Cloud Agent finishes responding.
          </p>
        </div>
        <Switch
          id={soundId}
          aria-describedby={descriptionId}
          checked={soundEnabled}
          onCheckedChange={setSoundEnabled}
        />
      </div>
    </section>
  );
}
