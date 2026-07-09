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

function AskKiloStory({ initialQuestion }: { initialQuestion?: string }) {
  return (
    <CostInsightsShellView owner={personalOwner} activePage="ask">
      <CostInsightsAskKiloView initialQuestion={initialQuestion} />
    </CostInsightsShellView>
  );
}

export const DisabledPreview: Story = {
  render: () => <AskKiloStory />,
};

export const DisabledPreviewWithQuestion: Story = {
  render: () => <AskKiloStory initialQuestion="Show my spend for the last 30 days" />,
};
