import type { Meta, StoryObj } from '@storybook/nextjs';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';

const meta: Meta = {
  title: 'Components/Overlays/HoverCard',
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultOpen: Story = {
  render: () => (
    <HoverCard open>
      <HoverCardTrigger asChild>
        <button className="text-link underline-offset-4 hover:underline">@kilo-code</button>
      </HoverCardTrigger>
      <HoverCardContent>
        <div className="flex gap-3">
          <Avatar>
            <AvatarFallback>KC</AvatarFallback>
          </Avatar>
          <div className="space-y-1">
            <h4 className="text-sm font-semibold">Kilo Code</h4>
            <p className="text-muted-foreground text-sm">
              Open source coding agent across editor, CLI, and cloud.
            </p>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  ),
};
