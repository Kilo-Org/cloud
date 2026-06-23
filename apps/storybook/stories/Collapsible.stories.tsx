import type { Meta, StoryObj } from '@storybook/nextjs';
import { ChevronsUpDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Button } from '@/components/ui/button';

const meta: Meta = {
  title: 'Components/Layout/Collapsible',
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultOpen: Story = {
  render: () => (
    <Collapsible
      defaultOpen
      className="w-[360px] space-y-2 rounded-xl border border-border bg-card p-4"
    >
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium">Recent branches</h3>
          <p className="text-muted-foreground text-xs">Used by latest cloud sessions.</p>
        </div>
        <CollapsibleTrigger asChild>
          <Button variant="ghost" size="icon" aria-label="Toggle branch list">
            <ChevronsUpDown className="size-4" />
          </Button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent className="space-y-2">
        {['main', 'jdp/storybook-v10', 'fix/billing-copy'].map(branch => (
          <div
            key={branch}
            className="rounded-md border border-border bg-surface-inset px-3 py-2 text-sm"
          >
            {branch}
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  ),
};
