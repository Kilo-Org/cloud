import type { Meta, StoryObj } from '@storybook/nextjs';
import { Info } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Banner } from '@/components/shared/Banner';

const meta: Meta = {
  title: 'PR: Standardize Banners/OldSessionBanner',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

export const Before: Story = {
  render: () => (
    <Alert variant="warning">
      <Info className="h-4 w-4" />
      <AlertTitle>Legacy Session</AlertTitle>
      <AlertDescription>
        <p className="mb-3">
          This is a legacy session displayed in read-only mode. You can start a new session to
          continue working.
        </p>
        <Button size="sm" variant="outline" onClick={() => {}}>
          Start New Session
        </Button>
      </AlertDescription>
    </Alert>
  ),
};

export const After: Story = {
  render: () => (
    <Banner color="amber">
      <Banner.Icon><Info /></Banner.Icon>
      <Banner.Content>
        <Banner.Title>Legacy Session</Banner.Title>
        <Banner.Description>
          This is a legacy session displayed in read-only mode. You can start a new session to
          continue working.
        </Banner.Description>
      </Banner.Content>
      <Banner.Action>
        <Banner.Button onClick={() => {}}>Start New Session</Banner.Button>
      </Banner.Action>
    </Banner>
  ),
};
