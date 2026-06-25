import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  CostInsightsEventHistoryView,
  CostInsightsShellView,
  type CostInsightsOwner,
  type CostInsightEvent,
} from '@/components/cost-insights';
import {
  allEvents,
  longLabelEvents,
  organizationOwner,
  personalOwner,
} from './costInsightsFixtures';

const paginatedEvents = Array.from({ length: 23 }, (_, index): CostInsightEvent => {
  const event = allEvents[index % allEvents.length];
  if (!event) throw new Error('Activity fixture requires at least one event');
  return {
    ...event,
    id: `${event.id}-${index}`,
    timestampLabel:
      index < 5 ? event.timestampLabel : `${Math.floor(index / 5) + 1} days ago, 09:15`,
  };
});

const meta: Meta<typeof CostInsightsEventHistoryView> = {
  title: 'Cost Insights/Activity',
  component: CostInsightsEventHistoryView,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof CostInsightsEventHistoryView>;

function renderActivity(
  events: CostInsightEvent[],
  owner: CostInsightsOwner = personalOwner,
  empty = false
) {
  return (
    <CostInsightsShellView owner={owner} activePage="events">
      <CostInsightsEventHistoryView events={events} empty={empty} />
    </CostInsightsShellView>
  );
}

export const ActivityHistory: Story = {
  render: () => renderActivity(paginatedEvents, organizationOwner),
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
