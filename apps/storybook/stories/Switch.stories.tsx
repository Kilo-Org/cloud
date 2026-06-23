import type { Meta, StoryObj } from '@storybook/nextjs';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';

const meta: Meta<typeof Switch> = {
  title: 'Components/Forms/Switch',
  component: Switch,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const States: Story = {
  render: () => (
    <div className="grid gap-4">
      <div className="flex items-center gap-3">
        <Switch id="sound-enabled" defaultChecked />
        <Label htmlFor="sound-enabled">Sound enabled</Label>
      </div>
      <div className="flex items-center gap-3">
        <Switch id="notifications" />
        <Label htmlFor="notifications">Notify on completion</Label>
      </div>
      <div className="flex items-center gap-3">
        <Switch id="locked-switch" disabled />
        <Label htmlFor="locked-switch">Locked by policy</Label>
      </div>
    </div>
  ),
};
