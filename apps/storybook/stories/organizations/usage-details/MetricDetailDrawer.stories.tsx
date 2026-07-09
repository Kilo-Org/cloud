import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import { MetricDetailDrawer } from '@/components/usage-analytics/MetricDetailDrawer';
import { Button } from '@/components/ui/button';

const meta: Meta<typeof MetricDetailDrawer> = {
  title: 'Usage Analytics/MetricDetailDrawer',
  component: MetricDetailDrawer,
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const chartData = Array.from({ length: 14 }, (_, i) => {
  const date = new Date(2026, 5, i + 1);
  const frequency = 40 + Math.round(Math.sin(i / 2) * 15 + i);
  const depth = 30 + Math.round(Math.cos(i / 3) * 12 + i);
  const coverage = 25 + Math.round(Math.sin(i / 4) * 10 + i);
  return {
    date: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    timestamp: date.getTime(),
    Frequency: frequency,
    Depth: depth,
    Coverage: coverage,
    total: frequency + depth + coverage,
  };
});

function MetricDetailDrawerDemo({ metric }: { metric: 'frequency' | 'depth' | 'coverage' }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="bg-background min-h-screen p-6">
      <Button onClick={() => setOpen(true)}>Open metric detail</Button>
      <MetricDetailDrawer
        open={open}
        onOpenChange={setOpen}
        metric={metric}
        organizationId="fake-org-1"
        chartData={chartData}
      />
    </div>
  );
}

export const Frequency: Story = {
  render: () => <MetricDetailDrawerDemo metric="frequency" />,
};

export const Depth: Story = {
  render: () => <MetricDetailDrawerDemo metric="depth" />,
};

export const Coverage: Story = {
  render: () => <MetricDetailDrawerDemo metric="coverage" />,
};
