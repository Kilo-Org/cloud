'use client';

import { useQuery } from '@tanstack/react-query';

import { useTRPC } from '@/lib/trpc/utils';
import { CostInsightsEventHistoryView } from './activity/CostInsightsEventHistoryView';

type CostInsightsActivityClientProps = {
  organizationId?: string;
};

export function CostInsightsActivityClient({ organizationId }: CostInsightsActivityClientProps) {
  const trpc = useTRPC();
  const personalEventsQuery = useQuery({
    ...trpc.costInsights.listEvents.queryOptions(),
    enabled: !organizationId,
  });
  const organizationEventsQuery = useQuery({
    ...trpc.organizations.costInsights.listEvents.queryOptions({
      organizationId: organizationId ?? '',
    }),
    enabled: Boolean(organizationId),
  });
  const eventsQuery = organizationId ? organizationEventsQuery : personalEventsQuery;

  return (
    <CostInsightsEventHistoryView
      events={eventsQuery.data ?? []}
      empty={(eventsQuery.data ?? []).length === 0}
      isLoading={eventsQuery.isLoading}
      isError={eventsQuery.isError}
    />
  );
}
