import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export type UsageDataErrorStateProps = {
  /**
   * The retry action for the `retryable` variant. Unused for `unavailable`,
   * which must not offer a retry at all.
   */
  onRetry?: () => void;

  /**
   * `retryable` is every ordinary query failure: the warehouse may answer the
   * next attempt, so the card offers another try. `unavailable` names the
   * workspace's unconfigured usage source
   * (`USAGE_SOURCE_NOT_CONFIGURED_MESSAGE`): retrying cannot create one, so
   * the card says so and offers no button.
   */
  variant?: 'retryable' | 'unavailable';
};

export function UsageDataErrorState({ onRetry, variant = 'retryable' }: UsageDataErrorStateProps) {
  const unavailable = variant === 'unavailable';

  return (
    <Card>
      <CardContent className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center sm:p-10">
        <AlertCircle className="text-muted-foreground size-5" />
        <div>
          <h2 className="type-heading">Usage data is unavailable</h2>
          <p className="type-body text-muted-foreground mt-1 max-w-md">
            {unavailable
              ? "This workspace isn't reporting usage. Retrying won't help."
              : 'The usage report could not be loaded. This is not an empty period — try loading it again.'}
          </p>
        </div>
        {!unavailable && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            Try again
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
