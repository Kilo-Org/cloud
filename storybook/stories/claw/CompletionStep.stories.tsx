import type { Meta, StoryObj } from '@storybook/nextjs';
import { CompletionStep } from '@/app/(app)/claw/components/CompletionStep';

const meta: Meta<typeof CompletionStep> = {
  title: 'Claw/CompletionStep',
  component: CompletionStep,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    Story => (
      <div className="mx-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    flyRegion: 'sfo',
  },
};

export const NoRegion: Story = {
  args: {
    flyRegion: null,
  },
};
