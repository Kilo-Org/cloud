import type { StoryObj } from '@storybook/react';
import { TypingIndicator } from '@/components/cloud-agent-next/TypingIndicator';
import HeaderLogo from '@/components/HeaderLogo';

type Story = StoryObj;

export const Normal: Story = {
  render: () => (
    <div className="flex flex-col gap-4">
      <TypingIndicator />
      <HeaderLogo />
    </div>
  ),
};

export const ReducedMotion: Story = {
  render: Normal.render,
};
