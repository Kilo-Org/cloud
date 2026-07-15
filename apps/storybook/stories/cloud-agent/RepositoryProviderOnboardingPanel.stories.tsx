import type { Meta, StoryObj } from '@storybook/nextjs';
import { RepositoryProviderOnboardingPanel } from '@/components/cloud-agent-next/RepositoryProviderOnboardingPanel';

const meta: Meta<typeof RepositoryProviderOnboardingPanel> = {
  title: 'Cloud Agent/RepositoryProviderOnboardingPanel',
  component: RepositoryProviderOnboardingPanel,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
  decorators: [
    Story => (
      <div className="w-[min(42rem,calc(100vw-2rem))]">
        <Story />
      </div>
    ),
  ],
  args: {
    onCheckConnection: () => {},
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Personal: Story = {};

export const Organization: Story = {
  args: {
    organizationId: '8e65c211-a284-4a57-a077-16db90751abc',
  },
};

export const CheckingConnection: Story = {
  args: {
    isCheckingConnection: true,
  },
};
