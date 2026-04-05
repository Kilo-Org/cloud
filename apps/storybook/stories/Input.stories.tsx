import type { Meta, StoryObj } from '@storybook/nextjs';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const meta: Meta<typeof Input> = {
  title: 'Components/Input',
  component: Input,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="w-64 space-y-2">
      <Label>Email</Label>
      <Input type="email" placeholder="Enter your email" />
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="w-64 space-y-2">
      <Label>Disabled Input</Label>
      <Input type="text" placeholder="This input is disabled" disabled />
    </div>
  ),
};
