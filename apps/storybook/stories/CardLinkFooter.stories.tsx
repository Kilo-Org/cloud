import type { Meta, StoryObj } from '@storybook/nextjs';
import { ArrowRight } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { CardLinkFooter } from '@/components/ui/card.client';

const meta: Meta<typeof CardLinkFooter> = {
  title: 'Components/Navigation/CardLinkFooter',
  component: CardLinkFooter,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <Card className="w-[360px]">
      <CardHeader>
        <CardTitle>Model routing</CardTitle>
        <CardDescription>Configure defaults for new agent sessions.</CardDescription>
      </CardHeader>
      <CardContent>
        <p className="text-muted-foreground text-sm">
          Hover the footer to check the interactive ripple treatment.
        </p>
        <CardLinkFooter href="#" className="flex items-center justify-between">
          Open model settings
          <ArrowRight className="size-4" aria-hidden="true" />
        </CardLinkFooter>
      </CardContent>
    </Card>
  ),
};
