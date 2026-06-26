'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc/utils';
import { CostInsightsEventHistoryView } from './activity/CostInsightsEventHistoryView';
import type { ActivityFilter } from './types';
import { useCostInsightsTracking } from './useCostInsightsTracking';

type CostInsightsActivityClientProps = {
  organizationId?: string;
};

export function CostInsightsActivityClient({ organizationId }: CostInsightsActivityClientProps) {
  const trpc = useTRPC();
  const { trackUiInteraction } = useCostInsightsTracking(organizationId);
  const trackedActivityOwner = useRef<string | undefined>(undefined);
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [page, setPage] = useState(1);
  const pageSize = 10;
  const {
    data: personalEvents,
    isLoading: personalEventsLoading,
    isError: personalEventsError,
    refetch: refetchPersonalEvents,
  } = useQuery({
    ...trpc.costInsights.listEvents.queryOptions({ filter, page, pageSize }),
    enabled: !organizationId,
  });
  const {
    data: organizationEvents,
    isLoading: organizationEventsLoading,
    isError: organizationEventsError,
    refetch: refetchOrganizationEvents,
  } = useQuery({
    ...trpc.organizations.costInsights.listEvents.queryOptions({
      organizationId: organizationId ?? '',
      filter,
      page,
      pageSize,
    }),
    enabled: Boolean(organizationId),
  });
  const history = organizationId ? organizationEvents : personalEvents;
  const isLoading = organizationId ? organizationEventsLoading : personalEventsLoading;
  const isError = organizationId ? organizationEventsError : personalEventsError;

  useEffect(() => {
    if (!history) return;
    const ownerKey = organizationId ?? 'personal';
    if (trackedActivityOwner.current === ownerKey) return;
    trackedActivityOwner.current = ownerKey;
    trackUiInteraction({ interaction: 'activity_viewed' });
  }, [history, organizationId, trackUiInteraction]);

  return (
    <CostInsightsEventHistoryView
      events={history?.events ?? []}
      empty={(history?.filter ?? filter) === 'all' && history?.totalCount === 0}
      isLoading={isLoading}
      isError={isError}
      filter={history?.filter ?? filter}
      page={history?.page ?? page}
      pageCount={history?.pageCount ?? 1}
      pageSize={history?.pageSize ?? pageSize}
      totalCount={history?.totalCount ?? 0}
      onFilterChange={nextFilter => {
        if (nextFilter !== filter) {
          trackUiInteraction({ interaction: 'activity_filter_selected', filter: nextFilter });
        }
        setFilter(nextFilter);
        setPage(1);
      }}
      onPageChange={nextPage => {
        if (nextPage !== page) {
          trackUiInteraction({
            interaction: 'activity_page_selected',
            direction: nextPage > page ? 'next' : 'previous',
          });
        }
        setPage(nextPage);
      }}
      onRetry={() => {
        void (organizationId ? refetchOrganizationEvents() : refetchPersonalEvents());
      }}
    />
  );
}
