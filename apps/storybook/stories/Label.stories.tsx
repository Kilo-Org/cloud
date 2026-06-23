import type { Meta, StoryObj } from '@storybook/nextjs';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const meta: Meta<typeof Label> = {
  title: 'Components/Forms/Label',
  component: Label,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Associations: Story = {
  render: () => (
    <div className="grid w-[320px] gap-5">
      <div className="grid gap-2">
        <Label htmlFor="workspace-name">Workspace name</Label>
        <Input id="workspace-name" defaultValue="Platform" />
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="label-checkbox" />
        <Label htmlFor="label-checkbox">Notify me when runs finish</Label>
      </div>
      <div className="grid gap-2 group" data-disabled="true">
        <Label htmlFor="disabled-label">Disabled label</Label>
        <Input id="disabled-label" disabled value="Locked by policy" readOnly />
      </div>
    </div>
  ),
};
