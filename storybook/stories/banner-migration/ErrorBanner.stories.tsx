import type { Meta, StoryObj } from '@storybook/nextjs';
import { AlertCircle, X } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/shared/Banner';

const meta: Meta = {
  title: 'PR: Standardize Banners/ErrorBanner',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

export const Before: Story = {
  render: () => (
    <Alert variant="destructive" className="relative">
      <AlertCircle className="h-4 w-4" />
      <AlertTitle>Error</AlertTitle>
      <AlertDescription>
        <p className="mb-3">Something went wrong while loading the session.</p>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => {}}>
            Retry
          </Button>
          <Button size="sm" variant="ghost" onClick={() => {}}>
            Dismiss
          </Button>
        </div>
      </AlertDescription>
      <button
        className="absolute top-2 right-2 rounded-md p-1 opacity-70 hover:opacity-100"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </Alert>
  ),
};

export const After: Story = {
  render: () => (
    <Banner color="red">
      <Banner.Icon>
        <AlertCircle />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>Error</Banner.Title>
        <Banner.Description>Something went wrong while loading the session.</Banner.Description>
      </Banner.Content>
      <Banner.Action>
        <Banner.Button onClick={() => {}}>Retry</Banner.Button>
        <Banner.Button onClick={() => {}}>Dismiss</Banner.Button>
      </Banner.Action>
      <Banner.Dismiss onDismiss={() => {}} />
    </Banner>
  ),
};
