'use client';

import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { CostInsightsLoadError } from '../shared/CostInsightsLoadError';
import { EmptyPanel } from '../shared/EmptyPanel';
import type { ActivityFilter, CostInsightEvent } from '../types';
import { EventList } from './EventList';

const ACTIVITY_PAGE_SIZE = 10;

function isActivityFilter(value: string): value is ActivityFilter {
  return ['all', 'alerts', 'suggestions', 'reviews', 'settings'].includes(value);
}

export function CostInsightsEventHistoryView({
  events,
  empty = false,
  isLoading = false,
  isError = false,
  initialFilter = 'all',
  initialPage = 1,
}: {
  events: CostInsightEvent[];
  empty?: boolean;
  isLoading?: boolean;
  isError?: boolean;
  initialFilter?: ActivityFilter;
  initialPage?: number;
}) {
  const [filter, setFilter] = useState<ActivityFilter>(initialFilter);
  const [page, setPage] = useState(initialPage);

  if (isLoading) return <Skeleton className="h-96 rounded-xl" />;
  if (isError) return <CostInsightsLoadError />;

  const filteredEvents = events.filter(event => {
    if (filter === 'alerts') return ['anomaly_alert', 'threshold_crossed'].includes(event.type);
    if (filter === 'suggestions')
      return ['suggestion_created', 'suggestion_dismissed'].includes(event.type);
    if (filter === 'reviews') return event.type === 'reviewed';
    if (filter === 'settings') return ['config_changed', 'disabled'].includes(event.type);
    return true;
  });
  const pageCount = Math.max(1, Math.ceil(filteredEvents.length / ACTIVITY_PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const pageEvents = filteredEvents.slice(
    (currentPage - 1) * ACTIVITY_PAGE_SIZE,
    currentPage * ACTIVITY_PAGE_SIZE
  );
  const firstResult = filteredEvents.length === 0 ? 0 : (currentPage - 1) * ACTIVITY_PAGE_SIZE + 1;
  const lastResult = Math.min(currentPage * ACTIVITY_PAGE_SIZE, filteredEvents.length);

  return (
    <Card className="min-w-0">
      <CardHeader className="border-b">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1.5">
            <Label htmlFor="activity-filter">Show</Label>
            <Select
              value={filter}
              onValueChange={value => {
                if (!isActivityFilter(value)) return;
                setFilter(value);
                setPage(1);
              }}
            >
              <SelectTrigger
                id="activity-filter"
                className="h-control-touch! w-full sm:h-control-default! sm:w-52"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All activity</SelectItem>
                <SelectItem value="alerts">Alerts</SelectItem>
                <SelectItem value="suggestions">Suggestions</SelectItem>
                <SelectItem value="reviews">Reviews</SelectItem>
                <SelectItem value="settings">Settings changes</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <span className="type-label text-muted-foreground" aria-live="polite">
            {filteredEvents.length === 0
              ? 'No matching activity'
              : `Showing ${firstResult}-${lastResult} of ${filteredEvents.length}`}
          </span>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {empty || events.length === 0 ? (
          <div className="p-6">
            <EmptyPanel
              title="No activity yet"
              description="Spend alerts, suggestions, and settings changes will appear here."
            />
          </div>
        ) : pageEvents.length === 0 ? (
          <div className="p-6">
            <EmptyPanel
              title="No matching activity"
              description="Choose another filter to see activity."
            />
          </div>
        ) : (
          <EventList events={pageEvents} />
        )}
      </CardContent>
      {pageCount > 1 && (
        <div className="border-t p-4 sm:px-6">
          <nav className="flex items-center justify-between gap-3" aria-label="Activity pages">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-control-touch md:min-h-0"
              disabled={currentPage === 1}
              onClick={() => setPage(currentPage - 1)}
            >
              <ChevronLeft className="size-4" aria-hidden="true" />
              Previous
            </Button>
            <span className="type-label text-muted-foreground tabular-nums">
              Page {currentPage} of {pageCount}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="min-h-control-touch md:min-h-0"
              disabled={currentPage === pageCount}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
              <ChevronRight className="size-4" aria-hidden="true" />
            </Button>
          </nav>
        </div>
      )}
    </Card>
  );
}
