import type { Meta, StoryObj } from '@storybook/nextjs';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const meta: Meta = {
  title: 'Components/Overlays/Popover',
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultOpen: Story = {
  render: () => (
    <Popover defaultOpen>
      <PopoverTrigger asChild>
        <Button variant="outline">Edit limit</Button>
      </PopoverTrigger>
      <PopoverContent>
        <div className="grid gap-3">
          <div>
            <h4 className="text-sm font-medium">Credit limit</h4>
            <p className="text-muted-foreground text-xs">Set a daily spend cap.</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="daily-limit">Daily limit</Label>
            <Input id="daily-limit" defaultValue="$40.00" />
          </div>
        </div>
      </PopoverContent>
    </Popover>
  ),
};
