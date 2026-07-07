'use client';

import { AlertCircle, RefreshCw } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

export function CostInsightsLoadError({ onRetry }: { onRetry?: () => void }) {
  const handleRetry = onRetry ?? (() => window.location.reload());
  return (
    <Alert variant="destructive">
      <AlertCircle className="size-4" aria-hidden="true" />
      <AlertTitle>Spend data could not load</AlertTitle>
      <AlertDescription className="space-y-3">
        <p>Check your connection and try again.</p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="min-h-control-touch md:min-h-0"
          onClick={handleRetry}
        >
          <RefreshCw className="size-4" aria-hidden="true" /> Retry
        </Button>
      </AlertDescription>
    </Alert>
  );
}
