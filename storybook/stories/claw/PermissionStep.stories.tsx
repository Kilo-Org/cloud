import type { Meta, StoryObj } from '@storybook/nextjs';
import { PermissionStep } from '@/app/(app)/claw/components/PermissionStep';

const meta: Meta<typeof PermissionStep> = {
  title: 'Claw/PermissionStep',
  component: PermissionStep,
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

export const Default: Story = {
  args: {
    instanceRunning: true,
  },
};

export const WithProvisioningBanner: Story = {
  args: {
    instanceRunning: false,
  },
};
