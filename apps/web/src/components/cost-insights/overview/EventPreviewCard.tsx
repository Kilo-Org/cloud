import { History } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EventList } from '../activity/EventList';
import type { CostInsightEvent } from '../types';

export function EventPreviewCard({ events }: { events: CostInsightEvent[] }) {
  return (
    <Card className="min-w-0">
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <CardTitle className="type-heading">Recent activity</CardTitle>
          <CardDescription>Alerts, suggestions, reviews, and settings changes.</CardDescription>
        </div>
        <Button type="button" variant="outline" className="min-h-control-touch sm:min-h-0">
          <History className="size-4" aria-hidden="true" />
          View all activity
        </Button>
      </CardHeader>
      <CardContent>
        <EventList events={events.slice(0, 4)} compact />
      </CardContent>
    </Card>
  );
}
