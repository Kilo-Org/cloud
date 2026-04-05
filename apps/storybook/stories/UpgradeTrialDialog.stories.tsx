import type { Meta, StoryObj } from '@storybook/nextjs';
import { UpgradeTrialDialog } from '@/components/organizations/UpgradeTrialDialog';
import { useState } from 'react';

const meta: Meta<typeof UpgradeTrialDialog> = {
  title: 'Organizations/Trial Nudges/Upgrade Dialog',
  component: UpgradeTrialDialog,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

// Interactive wrapper to control dialog state
const DialogWrapper = (args: React.ComponentProps<typeof UpgradeTrialDialog>) => {
  const [open, setOpen] = useState(true);

  return (
    <div>
      <button onClick={() => setOpen(true)} className="rounded bg-blue-600 px-4 py-2 text-white">
        Open Dialog
      </button>
      <UpgradeTrialDialog {...args} open={open} onOpenChange={setOpen} />
    </div>
  );
};

export const CurrentPlan_Teams: Story = {
  args: {
    organizationId: 'org-123',
    organizationName: 'Acme Corp',
    currentPlan: 'teams',
    open: true,
    onOpenChange: () => {},
  },
  render: DialogWrapper,
};

export const CurrentPlan_Enterprise: Story = {
  args: {
    organizationId: 'org-123',
    organizationName: 'Acme Corp',
    currentPlan: 'enterprise',
    open: true,
    onOpenChange: () => {},
  },
  render: DialogWrapper,
};
