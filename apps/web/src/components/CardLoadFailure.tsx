'use client';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * A card whose data read failed, with the retry the reader would otherwise have
 * to find by reloading the page.
 *
 * The description is the surface's own sentence. A page inside the app shell
 * has no navigation around it, so it has to say what a stranded reader can do;
 * a card on a dashboard that still stands does not.
 */
export function CardLoadFailure({
  title,
  description,
  onRetry,
}: {
  title: string;
  description: string;
  onRetry: () => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-muted-foreground text-sm">{description}</p>
        <Button variant="outline" onClick={onRetry}>
          Try again
        </Button>
      </CardContent>
    </Card>
  );
}
