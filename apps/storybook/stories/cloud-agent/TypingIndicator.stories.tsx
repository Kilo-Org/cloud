import type { Meta, StoryObj } from '@storybook/nextjs';
import { TypingIndicator } from '@/components/cloud-agent/TypingIndicator';

const meta: Meta<typeof TypingIndicator> = {
  title: 'Cloud Agent/TypingIndicator',
  component: TypingIndicator,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
