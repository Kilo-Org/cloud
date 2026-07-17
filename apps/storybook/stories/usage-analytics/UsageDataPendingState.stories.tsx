import type { Meta, StoryObj } from '@storybook/nextjs';
import { UsageDataPendingState } from '@/components/usage-analytics/UsageDataPendingState';

const meta: Meta<typeof UsageDataPendingState> = {
  title: 'Usage Analytics/UsageDataPendingState',
  component: UsageDataPendingState,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    Story => (
      <div className="bg-background min-h-screen p-6 sm:p-8">
        <div className="m-auto w-full max-w-4xl">
          <Story />
        </div>
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  parameters: {
    chromatic: { disableSnapshot: true },
  },
};
