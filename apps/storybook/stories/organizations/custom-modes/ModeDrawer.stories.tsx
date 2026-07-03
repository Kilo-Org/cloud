import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import { ModeDrawer } from '@/components/organizations/custom-modes/ModeDrawer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const meta: Meta<typeof ModeDrawer> = {
  title: 'Overlays/Drawers/ModeDrawer',
  component: ModeDrawer,
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

function ModeDrawerDemo({ withFooter }: { withFooter?: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="bg-background min-h-screen p-6">
      <Button onClick={() => setOpen(true)}>Open mode drawer</Button>
      <ModeDrawer
        open={open}
        onOpenChange={setOpen}
        title="Create custom mode"
        description="Define a reusable mode that your organization's members can select."
        footer={
          withFooter ? (
            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button onClick={() => setOpen(false)}>Save mode</Button>
            </div>
          ) : undefined
        }
      >
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="mode-name">Name</Label>
            <Input
              id="mode-name"
              placeholder="e.g. Security Reviewer"
              defaultValue="Security Reviewer"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mode-slug">Slug</Label>
            <Input
              id="mode-slug"
              placeholder="security-reviewer"
              defaultValue="security-reviewer"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="mode-instructions">Custom instructions</Label>
            <textarea
              id="mode-instructions"
              rows={8}
              className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
              defaultValue={
                'You are a meticulous security reviewer. Flag injection, auth bypass, and unsafe deserialization.'
              }
            />
          </div>
        </div>
      </ModeDrawer>
    </div>
  );
}

export const Default: Story = {
  render: () => <ModeDrawerDemo withFooter />,
};

export const WithoutFooter: Story = {
  render: () => <ModeDrawerDemo />,
};
