import type { Meta, StoryObj } from '@storybook/nextjs';
import { AlertTriangle, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/shared/Banner';
import { cn } from '@/lib/utils';

const meta: Meta = {
  title: 'PR: Standardize Banners/FreeTrialWarningBanner',
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj;

export const Before_Active: Story = {
  name: 'Before — trial_active',
  render: () => (
    <div
      className={cn(
        'flex w-full items-center gap-4 border-b p-4',
        'bg-blue-500/10 border-blue-500/50 text-blue-100'
      )}
    >
      <Clock className="h-6 w-6 shrink-0 text-blue-400" />
      <div className="flex-1">
        <div className="mb-1 flex items-center gap-2 text-sm">
          <span className="font-bold">Free Kilo Team Trial Active</span>
          <span className="opacity-70">&bull; 14 days left</span>
        </div>
        <p className="text-sm">Your trial expires on April 17, 2026.</p>
      </div>
      <Button onClick={() => {}} className="shrink-0 bg-blue-600 text-white hover:bg-blue-700">
        Upgrade Now
      </Button>
    </div>
  ),
};

export const After_Active: Story = {
  name: 'After — trial_active',
  render: () => (
    <Banner color="blue">
      <Banner.Icon>
        <Clock />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>
          Free Kilo Team Trial Active <span className="ml-2 opacity-70">&bull; 14 days left</span>
        </Banner.Title>
        <Banner.Description>Your trial expires on April 17, 2026.</Banner.Description>
      </Banner.Content>
      <Banner.Action>
        <Banner.Button onClick={() => {}}>Upgrade Now</Banner.Button>
      </Banner.Action>
    </Banner>
  ),
};

export const Before_EndingVerySoon: Story = {
  name: 'Before — ending_very_soon',
  render: () => (
    <div
      className={cn(
        'flex w-full items-center gap-4 border-b p-4',
        'bg-red-500/10 border-red-500/50 text-red-100'
      )}
    >
      <AlertTriangle className="h-6 w-6 shrink-0 text-red-400" />
      <div className="flex-1">
        <div className="mb-1 flex items-center gap-2 text-sm">
          <span className="font-bold">Free Kilo Team Trial Ending Very Soon</span>
          <span className="opacity-70">&bull; 1 day left</span>
        </div>
        <p className="text-sm">Your trial expires on April 4, 2026.</p>
      </div>
      <Button onClick={() => {}} className="shrink-0 bg-red-600 text-white hover:bg-red-700">
        Upgrade Now
      </Button>
    </div>
  ),
};

export const After_EndingVerySoon: Story = {
  name: 'After — ending_very_soon',
  render: () => (
    <Banner color="red">
      <Banner.Icon>
        <AlertTriangle />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>
          Free Kilo Team Trial Ending Very Soon{' '}
          <span className="ml-2 opacity-70">&bull; 1 day left</span>
        </Banner.Title>
        <Banner.Description>Your trial expires on April 4, 2026.</Banner.Description>
      </Banner.Content>
      <Banner.Action>
        <Banner.Button onClick={() => {}}>Upgrade Now</Banner.Button>
      </Banner.Action>
    </Banner>
  ),
};
