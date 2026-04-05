import type { Meta, StoryObj } from '@storybook/nextjs';
import { ShieldAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Banner } from '@/components/shared/Banner';

const meta: Meta = {
  title: 'PR: Standardize Banners/AdminViewingBanner',
  parameters: { layout: 'padded' },
};
export default meta;

type Story = StoryObj;

export const Before: Story = {
  render: () => (
    <Alert variant="warning" className="border-amber-500/50 bg-amber-50 dark:bg-amber-950/20">
      <ShieldAlert className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      <AlertTitle className="text-amber-800 dark:text-amber-200">Viewing as admin</AlertTitle>
      <AlertDescription className="text-amber-700 dark:text-amber-300">
        This town belongs to org{' '}
        <code className="rounded bg-amber-100 px-1 py-0.5 text-xs dark:bg-amber-900/40">
          org_abc123
        </code>
        . Changes to settings and destructive actions are restricted.
      </AlertDescription>
    </Alert>
  ),
};

export const After: Story = {
  render: () => (
    <Banner color="amber">
      <Banner.Icon>
        <ShieldAlert />
      </Banner.Icon>
      <Banner.Content>
        <Banner.Title>Viewing as admin</Banner.Title>
        <Banner.Description>
          This town belongs to org{' '}
          <code className="rounded bg-amber-100 px-1 py-0.5 text-xs dark:bg-amber-900/40">
            org_abc123
          </code>
          . Changes to settings and destructive actions are restricted.
        </Banner.Description>
      </Banner.Content>
    </Banner>
  ),
};
