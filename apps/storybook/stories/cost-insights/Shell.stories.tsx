import type { Meta, StoryObj } from '@storybook/nextjs';
import { CostInsightsShellView } from '@/components/cost-insights';
import { orgMemberOwner } from './costInsightsFixtures';

const meta: Meta<typeof CostInsightsShellView> = {
  title: 'Cost Insights/Access',
  component: CostInsightsShellView,
  parameters: { layout: 'fullscreen' },
};

export default meta;
type Story = StoryObj<typeof CostInsightsShellView>;

export const UnauthorizedOrganizationMember: Story = {
  args: {
    owner: orgMemberOwner,
    activePage: 'dashboard',
    unauthorized: true,
    children: null,
  },
};
