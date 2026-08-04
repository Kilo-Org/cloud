import Link from 'next/link';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';

type CostInsightsDiscontinuedNoticeProps = {
  /** Destination for the usage surface that replaces this page. */
  usageHref: string;
};

/**
 * Tombstone for the removed Cost Insights pages. It exists so bookmarks and
 * previously sent spend-alert emails land on an explanation instead of a 404.
 */
export function CostInsightsDiscontinuedNotice({ usageHref }: CostInsightsDiscontinuedNoticeProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Cost Insights has been discontinued</CardTitle>
        <CardDescription>
          This page is no longer available. Spend alerts, spend thresholds, and cost suggestions are
          turned off, and Kilo no longer sends spend alert emails.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col items-start gap-4">
        <p className="text-muted-foreground text-sm">
          Usage still shows credit spend over time, broken down by model and feature.
        </p>
        <Button asChild>
          <Link href={usageHref}>View usage</Link>
        </Button>
      </CardContent>
    </Card>
  );
}
