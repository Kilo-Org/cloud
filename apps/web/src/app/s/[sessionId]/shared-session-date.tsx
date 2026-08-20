'use client';

import { CalendarDays } from 'lucide-react';
import { formatSessionDate } from './shared-session-meta';

export function SharedSessionDate({ isoDate }: { isoDate: string | null }) {
  const formatted = formatSessionDate(isoDate);
  if (!formatted) return null;
  return (
    // Server and client format in different timezones, so a minor
    // mismatch is expected and harmless (same pattern as TimeAgo).
    <span className="inline-flex items-center gap-1" suppressHydrationWarning>
      <CalendarDays className="size-3.5" aria-hidden />
      {formatted}
    </span>
  );
}
