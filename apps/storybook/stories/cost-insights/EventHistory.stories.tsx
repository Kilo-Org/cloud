import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  CostInsightsEventHistoryView,
  CostInsightsShellView,
  type ActivityFilter,
  type CostInsightsOwner,
  type CostInsightEvent,
} from '@/components/cost-insights';
import {
  allEvents,
  longLabelEvents,
  organizationOwner,
  personalOwner,
  threshold7DayEvent,
} from './costInsightsFixtures';

const paginatedEvents = Array.from({ length: 23 }, (_, index): CostInsightEvent => {
  const event = allEvents[index % allEvents.length];
  if (!event) throw new Error('Activity fixture requires at least one event');
  return {
    ...event,
    id: `${event.id}-${index}`,
    occurredAt:
      index < 5
        ? event.occurredAt
        : new Date(
            new Date(event.occurredAt).getTime() - (Math.floor(index / 5) + 1) * 24 * 60 * 60 * 1000
          ).toISOString(),
  };
});

const meta: Meta<typeof CostInsightsEventHistoryView> = {
  title: 'Cost Insights/Activity',
  component: CostInsightsEventHistoryView,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof CostInsightsEventHistoryView>;

function ActivityStory({
  events,
  owner,
  empty,
}: {
  events: CostInsightEvent[];
  owner: CostInsightsOwner;
  empty: boolean;
}) {
  const [filter, setFilter] = useState<ActivityFilter>('all');
  const [page, setPage] = useState(1);
  const filteredEvents = events.filter(event => {
    if (filter === 'alerts') return ['anomaly_alert', 'threshold_crossed'].includes(event.type);
    if (filter === 'suggestions')
      return ['suggestion_created', 'suggestion_dismissed'].includes(event.type);
    if (filter === 'reviews') return event.type === 'reviewed';
    if (filter === 'settings') return ['config_changed', 'disabled'].includes(event.type);
    return true;
  });
  const pageCount = Math.max(1, Math.ceil(filteredEvents.length / 10));
  const currentPage = Math.min(page, pageCount);
  const pageEvents = filteredEvents.slice((currentPage - 1) * 10, currentPage * 10);
  const basePath =
    owner.type === 'organization'
      ? '/organizations/acme-cost-insights/cost-insights'
      : '/cost-insights';

  return (
    <CostInsightsShellView owner={owner} activePage="events" basePath={basePath}>
      <CostInsightsEventHistoryView
        events={pageEvents}
        empty={empty}
        filter={filter}
        page={currentPage}
        pageCount={pageCount}
        totalCount={filteredEvents.length}
        onFilterChange={nextFilter => {
          setFilter(nextFilter);
          setPage(1);
        }}
        onPageChange={setPage}
      />
    </CostInsightsShellView>
  );
}

function renderActivity(
  events: CostInsightEvent[],
  owner: CostInsightsOwner = personalOwner,
  empty = false
) {
  return <ActivityStory events={events} owner={owner} empty={empty} />;
}

export const ActivityHistory: Story = {
  render: () => renderActivity(paginatedEvents, organizationOwner),
};

export const SevenDayThresholdActivity: Story = {
  render: () => renderActivity([threshold7DayEvent], organizationOwner),
};

export const Empty: Story = {
  render: () => renderActivity([], personalOwner, true),
};

export const Loading: Story = {
  render: () => (
    <CostInsightsShellView owner={personalOwner} activePage="events">
      <CostInsightsEventHistoryView events={[]} isLoading />
    </CostInsightsShellView>
  ),
};

export const LoadError: Story = {
  render: () => (
    <CostInsightsShellView owner={personalOwner} activePage="events">
      <CostInsightsEventHistoryView events={[]} isError />
    </CostInsightsShellView>
  ),
};

export const Mobile: Story = {
  render: () => renderActivity(longLabelEvents, organizationOwner),
  globals: {
    viewport: { value: 'mobile2', isRotated: false },
  },
};
