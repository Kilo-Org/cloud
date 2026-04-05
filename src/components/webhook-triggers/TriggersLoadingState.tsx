'use client';

import { memo } from 'react';
import { Loader2 } from 'lucide-react';

/**
 * Loading state component for webhook triggers list.
 */
export const TriggersLoadingState = memo(function TriggersLoadingState() {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <Loader2 className="text-muted-foreground h-8 w-8 animate-spin" />
      <p className="text-muted-foreground mt-2">Loading triggers...</p>
    </div>
  );
});
