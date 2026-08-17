import type { Meta, StoryObj } from '@storybook/nextjs';
import { UsageDataErrorState } from '@/components/usage-analytics/UsageDataErrorState';

const meta: Meta<typeof UsageDataErrorState> = {
  title: 'Usage Analytics/UsageDataErrorState',
  component: UsageDataErrorState,
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
  args: {
    onRetry: () => undefined,
  },
};
