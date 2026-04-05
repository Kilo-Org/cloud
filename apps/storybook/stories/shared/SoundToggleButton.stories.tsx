import type { Meta, StoryObj } from '@storybook/nextjs';
import { useState } from 'react';
import { SoundToggleButton } from '@/components/shared/SoundToggleButton';

type StoryProps = {
  enabled?: boolean;
  size?: 'sm' | 'default';
};

function SoundToggleButtonStory({ enabled: initialEnabled = true, size = 'sm' }: StoryProps) {
  const [enabled, setEnabled] = useState(initialEnabled);

  return (
    <div className="flex items-center gap-4">
      <SoundToggleButton enabled={enabled} onToggle={() => setEnabled(!enabled)} size={size} />
      <span className="text-sm text-gray-400">Sound is {enabled ? 'enabled' : 'muted'}</span>
    </div>
  );
}

const meta: Meta<typeof SoundToggleButtonStory> = {
  title: 'Shared/SoundToggleButton',
  component: SoundToggleButtonStory,
  tags: ['autodocs'],
  parameters: {
    layout: 'centered',
  },
  argTypes: {
    enabled: {
      control: 'boolean',
      description: 'Whether sound is currently enabled',
    },
    size: {
      control: 'select',
      options: ['sm', 'default'],
      description: 'Size variant for the button',
    },
  },
};

export default meta;
type Story = StoryObj<typeof SoundToggleButtonStory>;

export const Enabled: Story = {
  args: {
    enabled: true,
  },
};

export const Muted: Story = {
  args: {
    enabled: false,
  },
};

export const DefaultSize: Story = {
  args: {
    enabled: true,
    size: 'default',
  },
};

export const SmallSize: Story = {
  args: {
    enabled: true,
    size: 'sm',
  },
};
