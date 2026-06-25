import type { Meta, StoryObj } from '@storybook/nextjs';
import { CostInsightsAskKiloView, CostInsightsShellView } from '@/components/cost-insights';
import { personalOwner } from './costInsightsFixtures';

const meta: Meta<typeof CostInsightsAskKiloView> = {
  title: 'Cost Insights/Ask Kilo',
  component: CostInsightsAskKiloView,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof CostInsightsAskKiloView>;

function AskKiloStory() {
  return (
    <CostInsightsShellView owner={personalOwner} activePage="ask">
      <CostInsightsAskKiloView />
    </CostInsightsShellView>
  );
}

export const Conversation: Story = {
  render: () => <AskKiloStory />,
};
