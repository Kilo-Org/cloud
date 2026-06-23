import type { Meta, StoryObj } from '@storybook/nextjs';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';

const meta: Meta<typeof Tabs> = {
  title: 'Components/Navigation/Tabs',
  component: Tabs,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Tabs defaultValue="overview" className="w-[420px]">
      <TabsList>
        <TabsTrigger value="overview">Overview</TabsTrigger>
        <TabsTrigger value="activity">Activity</TabsTrigger>
        <TabsTrigger value="settings" disabled>
          Settings
        </TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-medium">Overview</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Session health and cost summary for current workspace.
        </p>
      </TabsContent>
      <TabsContent value="activity" className="rounded-xl border border-border bg-card p-4">
        <h3 className="text-sm font-medium">Activity</h3>
        <p className="text-muted-foreground mt-1 text-sm">
          Recent agent actions and reviewer checkpoints.
        </p>
      </TabsContent>
    </Tabs>
  ),
};
