import type { Meta, StoryObj } from '@storybook/nextjs';
import { TypingIndicator } from '@/components/cloud-agent-next/TypingIndicator';
import HeaderLogo from '@/components/HeaderLogo';

const meta: Meta = {
  title: 'Accessibility/ReducedMotion',
  parameters: {
    layout: 'centered',
  },
};

export default meta;
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
  parameters: {
    chromatic: { pauseAnimationAtEnd: true },
  },
  render: Normal.render,
};
