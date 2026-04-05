import type { Meta, StoryObj } from '@storybook/nextjs';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';

const meta: Meta<typeof Textarea> = {
  title: 'Components/Textarea',
  component: Textarea,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="w-64 space-y-2">
      <Label>Description</Label>
      <Textarea placeholder="Enter a description" />
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="w-64 space-y-2">
      <Label>Disabled Textarea</Label>
      <Textarea placeholder="This textarea is disabled" disabled />
    </div>
  ),
};
