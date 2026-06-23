import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';
import { Slider } from '@/components/ui/slider';

const meta: Meta<typeof Slider> = {
  title: 'Components/Forms/Slider',
  component: Slider,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

function SliderExample() {
  const [value, setValue] = useState([40]);

  return (
    <div className="grid w-[360px] gap-3 rounded-xl border border-border bg-card p-4">
      <div className="flex justify-between text-sm">
        <span>Concurrency</span>
        <span className="text-muted-foreground tabular-nums">{value[0]}%</span>
      </div>
      <Slider min={0} max={100} step={5} value={value} onValueChange={setValue} />
    </div>
  );
}

export const Default: Story = {
  render: () => <SliderExample />,
};
