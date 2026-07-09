import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import { EmojiPicker } from '@/app/(app)/claw/kilo-chat/components/EmojiPicker';

const meta: Meta<typeof EmojiPicker> = {
  title: 'Overlays/Popovers/EmojiPicker',
  component: EmojiPicker,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

// EmojiPicker is a Radix Popover anchored to its trigger. The story opens it by
// default so the emoji-mart panel is captured in isolation.
function EmojiPickerDemo() {
  const [open, setOpen] = useState(true);
  return (
    <div className="flex min-h-[520px] items-center justify-center">
      <EmojiPicker
        open={open}
        onOpenChange={setOpen}
        onSelect={emoji => console.log('select', emoji)}
      >
        <button type="button" className="bg-muted text-foreground rounded-2xl px-3 py-2 text-sm">
          Add reaction
        </button>
      </EmojiPicker>
    </div>
  );
}

export const Default: Story = {
  render: () => <EmojiPickerDemo />,
};
