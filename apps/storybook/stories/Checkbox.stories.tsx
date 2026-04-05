import type { Meta, StoryObj } from '@storybook/nextjs';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';

const meta: Meta<typeof Checkbox> = {
  title: 'Components/Checkbox',
  component: Checkbox,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="flex items-center space-x-2">
      <Checkbox id="terms" />
      <Label htmlFor="terms">Accept terms and conditions</Label>
    </div>
  ),
};

export const Checked: Story = {
  render: () => (
    <div className="flex items-center space-x-2">
      <Checkbox id="terms-checked" checked />
      <Label htmlFor="terms-checked">Accept terms and conditions</Label>
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="flex items-center space-x-2">
      <Checkbox id="terms-disabled" disabled />
      <Label htmlFor="terms-disabled">Accept terms and conditions</Label>
    </div>
  ),
};
