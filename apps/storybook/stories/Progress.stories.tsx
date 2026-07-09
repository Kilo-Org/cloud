import type { Meta, StoryObj } from '@storybook/nextjs';
import { Progress } from '@/components/ui/progress';

const meta: Meta<typeof Progress> = {
  title: 'Components/Feedback/Progress',
  component: Progress,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Values: Story = {
  render: () => (
    <div className="grid w-[360px] gap-4">
      <div className="grid gap-2">
        <div className="flex justify-between text-sm">
          <span>Credit usage</span>
          <span className="text-muted-foreground tabular-nums">64%</span>
        </div>
        <Progress value={64} />
      </div>
      <Progress value={32} indicatorClassName="bg-status-success-icon" />
      <Progress value={86} indicatorClassName="bg-status-warning-icon" />
    </div>
  ),
};
