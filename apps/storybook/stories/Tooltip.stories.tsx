import type { Meta, StoryObj } from '@storybook/nextjs';
import { HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

const meta: Meta = {
  title: 'Components/Overlays/Tooltip',
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultOpen: Story = {
  render: () => (
    <Tooltip defaultOpen>
      <TooltipTrigger asChild>
        <Button variant="outline" size="icon" aria-label="Explain credit limit">
          <HelpCircle className="size-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent sideOffset={8}>Daily limit applies to new sessions.</TooltipContent>
    </Tooltip>
  ),
};
