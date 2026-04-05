import type { Meta, StoryObj } from '@storybook/nextjs';
import { FreeTrialWarningBanner } from '@/components/organizations/FreeTrialWarningBanner';
import { mockOrganization } from '../src/mockData/organizations';

const meta: Meta<typeof FreeTrialWarningBanner> = {
  title: 'Organizations/Trial Nudges/Banner',
  component: FreeTrialWarningBanner,
  parameters: {
    layout: 'padded',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

// Owner-specific examples for specific states
export const Owner_ActiveEarly: Story = {
  args: {
    organization: mockOrganization,
    daysRemaining: 25,
    userRole: 'owner',
    onUpgradeClick: () => console.log('Upgrade clicked'),
  },
};

export const Owner_EndingSoon: Story = {
  args: {
    organization: mockOrganization,
    daysRemaining: 7,
    userRole: 'owner',
    onUpgradeClick: () => console.log('Upgrade clicked'),
  },
};

export const Owner_ExpiresToday: Story = {
  args: {
    organization: mockOrganization,
    daysRemaining: 0,
    userRole: 'owner',
    onUpgradeClick: () => console.log('Upgrade clicked'),
  },
};

// Member-specific examples for specific states
export const Member_ActiveEarly: Story = {
  args: {
    organization: mockOrganization,
    daysRemaining: 25,
    userRole: 'member',
    onUpgradeClick: () => console.log('Upgrade clicked'),
  },
};

export const Member_EndingSoon: Story = {
  args: {
    organization: mockOrganization,
    daysRemaining: 7,
    userRole: 'member',
    onUpgradeClick: () => console.log('Upgrade clicked'),
  },
};

export const Member_ExpiresToday: Story = {
  args: {
    organization: mockOrganization,
    daysRemaining: 0,
    userRole: 'member',
    onUpgradeClick: () => console.log('Upgrade clicked'),
  },
};
