import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/nextjs';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';

const meta: Meta<typeof RadioGroup> = {
  title: 'Components/Forms/RadioGroup',
  component: RadioGroup,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

function RadioGroupExample() {
  const [value, setValue] = useState('cloud');

  return (
    <RadioGroup value={value} onValueChange={setValue} className="w-[320px]">
      {[
        ['cloud', 'Cloud agent'],
        ['cli', 'CLI'],
        ['disabled', 'Disabled option'],
      ].map(([optionValue, label]) => (
        <div key={optionValue} className="flex items-center gap-2">
          <RadioGroupItem
            value={optionValue}
            id={`radio-${optionValue}`}
            disabled={optionValue === 'disabled'}
          />
          <Label htmlFor={`radio-${optionValue}`}>{label}</Label>
        </div>
      ))}
    </RadioGroup>
  );
}

export const Default: Story = {
  render: () => <RadioGroupExample />,
};
