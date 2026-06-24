import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';
import { RangeSlider } from '@/components/ui/RangeSlider';

const meta: Meta<typeof RangeSlider> = {
  title: 'Components/Forms/RangeSlider',
  component: RangeSlider,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

function RangeSliderExample() {
  const [value, setValue] = useState<[number, number]>([20, 80]);

  return (
    <div className="w-[360px] rounded-xl border border-border bg-card p-4">
      <RangeSlider
        min={0}
        max={100}
        step={5}
        value={value}
        onChange={setValue}
        formatValue={amount => `$${amount}`}
      />
    </div>
  );
}

export const Default: Story = {
  render: () => <RangeSliderExample />,
};
