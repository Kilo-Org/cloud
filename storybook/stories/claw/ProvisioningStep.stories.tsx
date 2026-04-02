import type { Meta, StoryObj } from '@storybook/nextjs';
import {
  ProvisioningStepView,
  ProvisioningErrorView,
} from '@/app/(app)/claw/components/ProvisioningStep';

const meta: Meta<typeof ProvisioningStepView> = {
  title: 'Claw/ProvisioningStep',
  component: ProvisioningStepView,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    Story => (
      <div className="mx-auto flex w-full max-w-[1140px] flex-col gap-6 p-4 md:p-6">
        <Story />
      </div>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Error: StoryObj<Meta<typeof ProvisioningErrorView>> = {
  render: args => <ProvisioningErrorView {...args} />,
};
