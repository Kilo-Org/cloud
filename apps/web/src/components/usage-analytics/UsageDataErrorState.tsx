import { AlertCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

export type UsageDataErrorStateProps = {
  onRetry: () => void;
};

export function UsageDataErrorState({ onRetry }: UsageDataErrorStateProps) {
  return (
    <Card>
      <CardContent className="flex min-h-64 flex-col items-center justify-center gap-3 p-6 text-center sm:p-10">
        <AlertCircle className="text-muted-foreground size-5" />
        <div>
          <h2 className="type-heading">Usage data is unavailable</h2>
          <p className="type-body text-muted-foreground mt-1 max-w-md">
            The usage report could not be loaded. This is not an empty period — try loading it
            again.
          </p>
        </div>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
