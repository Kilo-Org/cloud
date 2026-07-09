import type { Meta, StoryObj } from '@storybook/nextjs';
import { AIAdoptionEmptyState } from '@/components/usage-analytics/AIAdoptionEmptyState';

const meta: Meta<typeof AIAdoptionEmptyState> = {
  title: 'Usage Analytics/AIAdoptionEmptyState',
  component: AIAdoptionEmptyState,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    Story => (
      <div className="bg-background min-h-screen p-8">
        <div className="m-auto w-full max-w-[1140px]">
          <Story />
        </div>
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

// The "Learn More" drawer is self-stateful (no open prop), so open it via its
// trigger button to capture the drawer surface.
export const DrawerOpen: Story = {
  play: async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    const buttons = Array.from(document.querySelectorAll('button'));
    const trigger = buttons.find(b => b.textContent?.includes('Learn More About AI Adoption'));
    trigger?.click();
  },
};
