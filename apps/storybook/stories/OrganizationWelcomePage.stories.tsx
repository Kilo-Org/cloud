import type { Meta, StoryObj } from '@storybook/nextjs';
import { OrganizationWelcomeCards } from '@/components/organizations/welcome/OrganizationWelcomeCards';

const meta: Meta<typeof OrganizationWelcomeCards> = {
  title: 'Organizations/Onboarding/OrganizationWelcomePage',
  component: OrganizationWelcomeCards,
  parameters: { layout: 'fullscreen' },
  decorators: [
    Story => (
      <div className="bg-background min-h-screen p-8">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof OrganizationWelcomeCards>;

export const Default: Story = {
  args: {
    onInviteMemberClick: () => console.log('Invite member clicked'),
    onBuyCreditsClick: () => console.log('Buy credits clicked'),
  },
  globals: {
    viewport: { value: 'desktop', isRotated: false },
  },
};

export const Mobile: Story = {
  args: {
    onInviteMemberClick: () => console.log('Invite member clicked'),
    onBuyCreditsClick: () => console.log('Buy credits clicked'),
  },
  globals: {
    viewport: { value: 'mobile2', isRotated: false },
  },
};
