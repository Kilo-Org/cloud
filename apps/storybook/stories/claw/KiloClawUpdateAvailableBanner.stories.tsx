import type { Meta, StoryObj } from '@storybook/nextjs';
import { KiloClawUpdateAvailableBanner } from '@/app/(app)/claw/components/KiloClawUpdateAvailableBanner';

const meta = {
  title: 'Claw/UpdateAvailableBanner',
  component: KiloClawUpdateAvailableBanner,
  parameters: {
    layout: 'padded',
    backgrounds: {
      default: 'dark',
    },
  },
  args: {
    catalogNewerThanImage: false,
    onUpgrade: () => undefined,
    onDismiss: () => undefined,
  },
  decorators: [
    Story => (
      <div className="mx-auto w-full max-w-[1140px]">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof KiloClawUpdateAvailableBanner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const KiloClawOnly: Story = {};

export const IncludesNewOpenClawVersion: Story = {
  args: {
    catalogNewerThanImage: true,
  },
};

export const StateComparison: Story = {
  render: args => (
    <div className="flex flex-col gap-4">
      <KiloClawUpdateAvailableBanner {...args} catalogNewerThanImage={false} />
      <KiloClawUpdateAvailableBanner {...args} catalogNewerThanImage />
    </div>
  ),
};
