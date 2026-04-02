import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DetailPageHeader } from '@/components/subscriptions/DetailPageHeader';

export function CodingPlanDetail() {
  return (
    <div className="space-y-6">
      <DetailPageHeader
        backHref="/subscriptions"
        backLabel="Back to subscriptions"
        title="Coding Plans"
        status="coming_soon"
      />
      <Card>
        <CardHeader>
          <CardTitle>Coming soon</CardTitle>
        </CardHeader>
        <CardContent>
          Coding Plans subscriptions are deferred and will ship in a follow-up change.
        </CardContent>
      </Card>
    </div>
  );
}
