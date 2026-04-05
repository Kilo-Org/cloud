'use client';

import { memo } from 'react';
import { Button } from '@/components/ui/button';
import { AlertCircle, RefreshCw } from 'lucide-react';

type TriggersErrorStateProps = {
  error: { message: string } | null;
  onRetry: () => void;
};

/**
 * Error state component for webhook triggers list.
 */
export const TriggersErrorState = memo(function TriggersErrorState({
  error,
  onRetry,
}: TriggersErrorStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-12">
      <AlertCircle className="text-destructive h-8 w-8" />
      <p className="text-muted-foreground mt-2">
        Failed to load triggers: {error?.message || 'Unknown error'}
      </p>
      <Button variant="outline" onClick={onRetry} className="mt-4">
        <RefreshCw className="mr-2 h-4 w-4" />
        Retry
      </Button>
    </div>
  );
});
