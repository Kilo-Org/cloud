import type { Meta, StoryObj } from '@storybook/nextjs';
import { CreateInstanceCardView } from '@/app/(app)/claw/components/CreateInstanceCard';

const meta = {
  title: 'Claw/Onboarding/FirstStep',
  component: CreateInstanceCardView,
  parameters: {
    layout: 'fullscreen',
    backgrounds: {
      default: 'dark',
    },
  },
  args: {
    canStartTrial: true,
    isPending: false,
    onCreate: () => undefined,
  },
  decorators: [
    Story => (
      <main className="min-h-screen p-4 md:p-6">
        <div className="mx-auto w-full max-w-[1140px]">
          <Story />
        </div>
      </main>
    ),
  ],
} satisfies Meta<typeof CreateInstanceCardView>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const SettingUp: Story = {
  args: {
    isPending: true,
  },
};
