import type { Meta, StoryObj } from '@storybook/nextjs';
import { AlertCircle, Clock, CreditCard } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/shared/Banner';
import { cn } from '@/lib/utils';

const meta: Meta = {
  title: 'PR: Standardize Banners/BillingBanner',
  parameters: { layout: 'padded' },
};
export default meta;
type Story = StoryObj;

export const Before_TrialActive: Story = {
  name: 'Before — trial_active',
  render: () => (
    <div className={cn('flex w-full items-center gap-4 rounded-xl border p-4', 'bg-blue-500/10 border-blue-500/30 text-blue-400')}>
      <Clock className="h-6 w-6 shrink-0" />
      <div className="flex-1">
        <div className="mb-0.5 text-sm font-bold">Free Trial — 12 days remaining</div>
        <p className="text-muted-foreground text-sm">Your trial expires on April 15, 2026.</p>
      </div>
      <Button onClick={() => {}} variant="primary" className="shrink-0">Subscribe Now</Button>
    </div>
  ),
};

export const After_TrialActive: Story = {
  name: 'After — trial_active',
  render: () => (
    <Banner color="blue">
      <Banner.Icon><Clock /></Banner.Icon>
      <Banner.Content>
        <Banner.Title>Free Trial — 12 days remaining</Banner.Title>
        <Banner.Description>Your trial expires on April 15, 2026.</Banner.Description>
      </Banner.Content>
      <Banner.Action>
        <Banner.Button onClick={() => {}}>Subscribe Now</Banner.Button>
      </Banner.Action>
    </Banner>
  ),
};

export const Before_EndingSoon: Story = {
  name: 'Before — trial_ending_soon',
  render: () => (
    <div className={cn('flex w-full items-center gap-4 rounded-xl border p-4', 'bg-amber-500/10 border-amber-500/30 text-amber-400')}>
      <AlertCircle className="h-6 w-6 shrink-0" />
      <div className="flex-1">
        <div className="mb-0.5 text-sm font-bold">Free Trial Ending Soon — 3 days left</div>
        <p className="text-muted-foreground text-sm">Your trial expires on April 6, 2026.</p>
      </div>
      <Button onClick={() => {}} variant="primary" className="shrink-0">Subscribe Now</Button>
    </div>
  ),
};

export const After_EndingSoon: Story = {
  name: 'After — trial_ending_soon',
  render: () => (
    <Banner color="amber">
      <Banner.Icon><AlertCircle /></Banner.Icon>
      <Banner.Content>
        <Banner.Title>Free Trial Ending Soon — 3 days left</Banner.Title>
        <Banner.Description>Your trial expires on April 6, 2026.</Banner.Description>
      </Banner.Content>
      <Banner.Action>
        <Banner.Button onClick={() => {}}>Subscribe Now</Banner.Button>
      </Banner.Action>
    </Banner>
  ),
};

export const Before_PastDue: Story = {
  name: 'Before — past_due',
  render: () => (
    <div className={cn('flex w-full items-center gap-4 rounded-xl border p-4', 'bg-red-500/10 border-red-500/30 text-red-400')}>
      <CreditCard className="h-6 w-6 shrink-0" />
      <div className="flex-1">
        <div className="mb-0.5 text-sm font-bold">Payment failed — action required</div>
        <p className="text-muted-foreground text-sm">Your subscription payment failed. Update your payment method.</p>
      </div>
      <Button onClick={() => {}} variant="primary" className="shrink-0">Update Payment</Button>
    </div>
  ),
};

export const After_PastDue: Story = {
  name: 'After — past_due',
  render: () => (
    <Banner color="red">
      <Banner.Icon><CreditCard /></Banner.Icon>
      <Banner.Content>
        <Banner.Title>Payment failed — action required</Banner.Title>
        <Banner.Description>Your subscription payment failed. Update your payment method.</Banner.Description>
      </Banner.Content>
      <Banner.Action>
        <Banner.Button onClick={() => {}}>Update Payment</Banner.Button>
      </Banner.Action>
    </Banner>
  ),
};
