import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';
import { RadioButtonGroup } from '@/components/ui/RadioGroup';

const meta: Meta<typeof RadioButtonGroup> = {
  title: 'Components/Forms/RadioButtonGroup',
  component: RadioButtonGroup,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

function RadioButtonGroupExample() {
  const [value, setValue] = useState('balanced');

  return (
    <div className="w-[360px]">
      <RadioButtonGroup
        value={value}
        onChange={setValue}
        options={[
          { value: 'fast', label: 'Fast' },
          { value: 'balanced', label: 'Balanced' },
          { value: 'thorough', label: 'Thorough' },
        ]}
      />
    </div>
  );
}

export const Default: Story = {
  render: () => <RadioButtonGroupExample />,
};
