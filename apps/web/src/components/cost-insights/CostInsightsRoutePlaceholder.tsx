import { Card, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

export function CostInsightsRoutePlaceholder({
  section,
}: {
  section: 'Overview' | 'Ask Kilo' | 'Activity' | 'Alert settings';
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{section}</CardTitle>
        <CardDescription>
          Cost Insights data will appear here when spend data is connected.
        </CardDescription>
      </CardHeader>
    </Card>
  );
}
