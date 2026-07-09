import type { Meta, StoryObj } from '@storybook/nextjs';
import { BooleanBadge } from '@/components/ui/boolean-badge';

const meta: Meta<typeof BooleanBadge> = {
  title: 'Components/Data Display/BooleanBadge',
  component: BooleanBadge,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = {
  render: () => (
    <div className="flex flex-wrap items-center gap-2">
      <BooleanBadge positive>Active</BooleanBadge>
      <BooleanBadge positive>+$50.00</BooleanBadge>
      <BooleanBadge positive={false}>Disabled</BooleanBadge>
      <BooleanBadge positive={false}>-$12.00</BooleanBadge>
    </div>
  ),
};
