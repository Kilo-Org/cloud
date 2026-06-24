import type { Meta, StoryObj } from '@storybook/nextjs';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';

const meta: Meta = {
  title: 'Components/Overlays/Sheet',
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const RightOpen: Story = {
  render: () => (
    <Sheet defaultOpen>
      <SheetTrigger asChild>
        <Button>Open details</Button>
      </SheetTrigger>
      <SheetContent>
        <SheetHeader>
          <SheetTitle>Session details</SheetTitle>
          <SheetDescription>Review runtime settings before handoff.</SheetDescription>
        </SheetHeader>
        <div className="grid gap-3 px-4 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">Model</span>
            <span>GPT-5.5</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">Mode</span>
            <span>Code review</span>
          </div>
        </div>
        <SheetFooter>
          <Button>Start session</Button>
          <Button variant="outline">Cancel</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  ),
};
