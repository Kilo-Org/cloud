import type { Meta, StoryObj } from '@storybook/nextjs';
import { Toaster } from '@/components/ui/sonner';

const meta: Meta<typeof Toaster> = {
  title: 'Components/Feedback/Sonner',
  component: Toaster,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
      <Toaster />
      Toast viewport mounted. Trigger toasts from app actions using the shared Sonner instance.
    </div>
  ),
};
