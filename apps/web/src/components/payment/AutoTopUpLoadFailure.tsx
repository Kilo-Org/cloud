'use client';

import { Button } from '@/components/ui/button';

/**
 * Shown in place of the automatic top up controls when their settings read fails, so a Stripe
 * outage does not leave the section blank or misleading. The retry re-runs the query the user
 * would otherwise have to recover by reloading the page.
 */
export function AutoTopUpLoadFailure({ onRetry }: { onRetry: () => void }) {
  return (
    <div role="alert" className="mt-1 flex flex-col items-start gap-3">
      <p className="text-muted-foreground text-sm">
        Could not load your automatic top up settings.
      </p>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
