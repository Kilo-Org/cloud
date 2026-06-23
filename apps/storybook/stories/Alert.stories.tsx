import type { Meta, StoryObj } from '@storybook/nextjs';
import { AlertCircle, CheckCircle2, Info, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';

const meta: Meta = {
  title: 'Components/Feedback/Alert',
  parameters: {
    layout: 'centered',
  },
  decorators: [
    Story => (
      <div className="grid w-[520px] gap-3">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Variants: Story = {
  render: () => (
    <>
      <Alert>
        <CheckCircle2 aria-hidden="true" />
        <AlertTitle>Usage limit updated</AlertTitle>
        <AlertDescription>New limits apply to future sessions.</AlertDescription>
      </Alert>
      <Alert variant="notice">
        <Info aria-hidden="true" />
        <AlertTitle>Deployment queued</AlertTitle>
        <AlertDescription>Vercel will publish after checks complete.</AlertDescription>
      </Alert>
      <Alert variant="warning">
        <TriangleAlert aria-hidden="true" />
        <AlertTitle>Credits running low</AlertTitle>
        <AlertDescription>Top up before long-running agents start.</AlertDescription>
      </Alert>
      <Alert variant="destructive">
        <AlertCircle aria-hidden="true" />
        <AlertTitle>Action blocked</AlertTitle>
        <AlertDescription>Review required before deleting this token.</AlertDescription>
      </Alert>
    </>
  ),
};
