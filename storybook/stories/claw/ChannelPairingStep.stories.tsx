import type { Meta, StoryObj } from '@storybook/nextjs';
import { ChannelPairingStepView } from '@/app/(app)/claw/components/ChannelPairingStep';

const meta: Meta<typeof ChannelPairingStepView> = {
  title: 'Claw/ChannelPairingStep',
  component: ChannelPairingStepView,
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

export const TelegramWaiting: Story = {
  args: {
    channelId: 'telegram',
    matchingRequest: null,
  },
};

export const DiscordWaiting: Story = {
  args: {
    channelId: 'discord',
    matchingRequest: null,
  },
};

export const TelegramWithRequest: Story = {
  args: {
    channelId: 'telegram',
    matchingRequest: { code: '3YPKLDPP', channel: 'telegram', id: '829104561' },
  },
};

export const DiscordWithRequest: Story = {
  args: {
    channelId: 'discord',
    matchingRequest: { code: 'K7WMRX2Q', channel: 'discord', id: '491028374165' },
  },
};

export const Approving: Story = {
  args: {
    channelId: 'telegram',
    matchingRequest: { code: '3YPKLDPP', channel: 'telegram', id: '829104561' },
    isApproving: true,
  },
};
