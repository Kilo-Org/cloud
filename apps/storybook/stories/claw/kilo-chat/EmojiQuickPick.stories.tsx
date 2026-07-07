import type { Meta, StoryObj } from '@storybook/nextjs';
import { EmojiQuickPick } from '@/app/(app)/claw/kilo-chat/components/EmojiQuickPick';

const meta: Meta<typeof EmojiQuickPick> = {
  title: 'Overlays/Popovers/EmojiQuickPick',
  component: EmojiQuickPick,
  parameters: {
    layout: 'centered',
  },
  args: {
    onSelect: emoji => console.log('select', emoji),
    onOpenFullPicker: () => console.log('open full picker'),
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    currentUserReactions: new Set<string>(),
  },
};

export const WithActiveReactions: Story = {
  args: {
    currentUserReactions: new Set<string>(['👍', '🎉']),
  },
};
