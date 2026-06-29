import type { Meta, StoryObj } from '@storybook/nextjs';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const meta: Meta = {
  title: 'Components/Overlays/Dialog',
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultOpen: Story = {
  render: () => (
    <Dialog defaultOpen>
      <DialogTrigger asChild>
        <Button>Edit profile</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit profile</DialogTitle>
          <DialogDescription>Update session defaults for this workspace.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Label htmlFor="profile-name">Profile name</Label>
          <Input id="profile-name" defaultValue="Production support" />
        </div>
        <DialogFooter>
          <Button variant="outline">Cancel</Button>
          <Button>Save profile</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ),
};
