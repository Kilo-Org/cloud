import type { Meta, StoryObj } from '@storybook/nextjs';
import { PlanCard } from '@/components/organizations/subscription/PlanCard';
import { TEAMS_FEATURES, ENTERPRISE_FEATURES } from '@/components/organizations/UpgradeTrialDialog';
import {
  TEAM_SEAT_PRICE_MONTHLY_USD,
  ENTERPRISE_SEAT_PRICE_MONTHLY_USD,
} from '@/lib/organizations/constants';

const meta: Meta<typeof PlanCard> = {
  title: 'Organizations/Components/Plan Card',
  component: PlanCard,
  parameters: {
    layout: 'centered',
  },
  args: {
    onSelect: () => console.log('Plan selected'),
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Teams_WhenOnTeams: Story = {
  args: {
    plan: 'teams',
    pricePerMonth: TEAM_SEAT_PRICE_MONTHLY_USD,
    features: TEAMS_FEATURES,
    isSelected: false,
    currentPlan: 'teams',
  },
};

export const Teams_WhenOnEnterprise: Story = {
  args: {
    plan: 'teams',
    pricePerMonth: TEAM_SEAT_PRICE_MONTHLY_USD,
    features: TEAMS_FEATURES,
    isSelected: false,
    currentPlan: 'enterprise',
  },
};

export const Enterprise_WhenOnTeams: Story = {
  args: {
    plan: 'enterprise',
    pricePerMonth: ENTERPRISE_SEAT_PRICE_MONTHLY_USD,
    features: ENTERPRISE_FEATURES,
    isSelected: false,
    currentPlan: 'teams',
  },
};

export const Enterprise_WhenOnEnterprise: Story = {
  args: {
    plan: 'enterprise',
    pricePerMonth: ENTERPRISE_SEAT_PRICE_MONTHLY_USD,
    features: ENTERPRISE_FEATURES,
    isSelected: false,
    currentPlan: 'enterprise',
  },
};
