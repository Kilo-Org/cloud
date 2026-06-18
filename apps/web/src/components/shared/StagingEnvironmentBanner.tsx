'use client';

import { useState } from 'react';
import { FlaskConical } from 'lucide-react';

export function StagingEnvironmentBanner() {
  const [dismissed, setDismissed] = useState(false);

  if (dismissed) return null;

  return (
    <aside className="relative z-50 flex min-h-9 w-full shrink-0 items-center justify-center gap-2 border-b border-amber-300 bg-amber-400 px-3 py-2 text-center text-xs font-medium text-amber-950 sm:text-sm">
      <FlaskConical aria-hidden="true" className="size-4 shrink-0" />
      <span className="font-bold tracking-wider uppercase">Staging</span>
      <span aria-hidden="true" className="h-3 w-px bg-amber-950/30" />
      <span>This is a test environment.</span>
      <button
        type="button"
        aria-label="Dismiss staging banner"
        onClick={() => setDismissed(true)}
        className="absolute right-3 font-bold text-amber-950/70 hover:text-amber-950"
      >
        ×
      </button>
    </aside>
  );
}
