import type { Meta, StoryObj } from '@storybook/nextjs';
import { FreeTrialWarningDialog } from '@/components/organizations/FreeTrialWarningDialog';
import { mockOrganization } from '../src/mockData/organizations';

const meta: Meta<typeof FreeTrialWarningDialog> = {
  title: 'Organizations/Trial Nudges/Dialog',
  component: FreeTrialWarningDialog,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

// Soft Lock examples - can browse in read-only
export const SoftLock_OneDayExpired: Story = {
  args: {
    trialStatus: 'trial_expired_soft',
    daysExpired: 1,
    organization: mockOrganization,
    onClose: () => console.log('Close clicked'),
    onUpgradeClick: () => console.log('Upgrade clicked'),
  },
};

export const SoftLock_ThreeDaysExpired: Story = {
  args: {
    trialStatus: 'trial_expired_soft',
    daysExpired: 3,
    organization: { ...mockOrganization, plan: 'teams' },
    onClose: () => console.log('Close clicked'),
    onUpgradeClick: () => console.log('Upgrade clicked'),
  },
};

// Hard Lock examples - completely blocked
export const HardLock_FourDaysExpired: Story = {
  args: {
    trialStatus: 'trial_expired_hard',
    daysExpired: 4,
    organization: mockOrganization,
    onUpgradeClick: () => console.log('Upgrade clicked'),
  },
};

export const HardLock_SevenDaysExpired: Story = {
  args: {
    trialStatus: 'trial_expired_hard',
    daysExpired: 7,
    organization: { ...mockOrganization, plan: 'teams' },
    onUpgradeClick: () => console.log('Upgrade clicked'),
  },
};
