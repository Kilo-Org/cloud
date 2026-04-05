import type { Meta, StoryObj } from '@storybook/nextjs';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/shared/Banner';
import { cn } from '@/lib/utils';

const meta: Meta = {
  title: 'PR: Standardize Banners/InsufficientBalanceBanner',
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj;

export const Before_Default: Story = {
  name: 'Before — default',
  render: () => (
    <div
      className={cn(
        'flex w-full items-center gap-4 rounded-lg border p-4',
        'border-yellow-500/50 bg-yellow-500/10 text-yellow-100'
      )}
    >
      <AlertTriangle className="h-6 w-6 shrink-0 text-yellow-400" />
      <div className="flex-1">
        <div className="mb-1 flex items-center gap-2 text-sm">
          <span className="font-bold">Insufficient Balance</span>
          <span className="opacity-70">&bull; Current: $0.42</span>
        </div>
        <p className="text-sm">App Builder requires a minimum balance of $1 to start.</p>
      </div>
      <Button onClick={() => {}} className="shrink-0 bg-yellow-600 text-white hover:bg-yellow-700">
        Add Credits
      </Button>
    </div>
  ),
};

export const After_Default: Story = {
  name: 'After — default',
  render: () => (
    <Banner color="amber" className="rounded-lg">
      <Banner.Icon>
        <AlertTriangle />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>
          Insufficient Balance <span className="ml-2 opacity-70">&bull; Current: $0.42</span>
        </Banner.Title>
        <Banner.Description>
          App Builder requires a minimum balance of $1 to start.
        </Banner.Description>
      </Banner.Content>
      <Banner.Action>
        <Banner.Button onClick={() => {}}>Add Credits</Banner.Button>
      </Banner.Action>
    </Banner>
  ),
};

export const Before_Compact: Story = {
  name: 'Before — compact',
  render: () => (
    <div
      className={cn(
        'flex w-full flex-col gap-3 rounded-lg border p-3',
        'border-yellow-500/50 bg-yellow-500/10 text-yellow-100'
      )}
    >
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0 text-yellow-400" />
        <span className="text-sm font-bold">Insufficient Balance</span>
        <span className="text-xs opacity-70">($0.42)</span>
      </div>
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs opacity-80">Add credits to continue</p>
        <Button
          size="sm"
          onClick={() => {}}
          className="shrink-0 bg-yellow-600 text-white hover:bg-yellow-700"
        >
          Add Credits
        </Button>
      </div>
    </div>
  ),
};

export const After_Compact: Story = {
  name: 'After — compact',
  render: () => (
    <Banner color="amber" className="flex-col gap-3 rounded-lg p-3 sm:items-start">
      <div className="flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 shrink-0" />
        <span className="text-sm font-bold">Insufficient Balance</span>
        <span className="text-xs opacity-70">($0.42)</span>
      </div>
      <div className="flex w-full items-center justify-between gap-2">
        <p className="text-xs opacity-80">Add credits to continue</p>
        <Banner.Button onClick={() => {}} className="shrink-0 text-xs">
          Add Credits
        </Banner.Button>
      </div>
    </Banner>
  ),
};
