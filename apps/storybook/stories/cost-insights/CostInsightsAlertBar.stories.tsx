import type { Meta, StoryObj } from '@storybook/nextjs';
import { CostInsightsAlertBar } from '@/components/cost-insights';
import { organizationOwner } from './costInsightsFixtures';

const meta = {
  title: 'Cost Insights/In-App Alert Bar',
  component: CostInsightsAlertBar,
  parameters: { layout: 'fullscreen' },
  args: {
    owner: organizationOwner,
    alertCount: 2,
    reviewHref: '/organizations/4f2fc143-4b30-4c8a-878b-df89c89c6790/cost-insights',
  },
  decorators: [
    Story => (
      <div className="bg-background min-h-screen">
        <header className="border-border bg-surface-raised flex h-14 items-center border-b px-4 type-body font-semibold md:px-6">
          Kilo Cloud
        </header>
        <Story />
        <main className="mx-auto max-w-[1140px] p-4 md:p-6">
          <div className="type-heading">Account overview</div>
        </main>
      </div>
    ),
  ],
} satisfies Meta<typeof CostInsightsAlertBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const AlertsNeedReview: Story = {};
