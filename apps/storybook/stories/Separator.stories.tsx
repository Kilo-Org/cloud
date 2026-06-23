import type { Meta, StoryObj } from '@storybook/nextjs';
import { Separator } from '@/components/ui/separator';

const meta: Meta<typeof Separator> = {
  title: 'Components/Layout/Separator',
  component: Separator,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Orientations: Story = {
  render: () => (
    <div className="flex h-24 w-[360px] items-center gap-4 rounded-xl border border-border bg-card p-4">
      <div className="grid gap-1">
        <h3 className="text-sm font-medium">Billing</h3>
        <p className="text-muted-foreground text-xs">Plan and credit controls.</p>
      </div>
      <Separator orientation="vertical" />
      <div className="grid flex-1 gap-2">
        <span className="text-sm">Current usage</span>
        <Separator />
        <span className="text-muted-foreground text-xs">$18.42 this month</span>
      </div>
    </div>
  ),
};
