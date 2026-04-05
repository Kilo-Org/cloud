import type { Meta, StoryObj } from '@storybook/nextjs';
import { InsufficientBalanceBanner } from '@/components/shared/InsufficientBalanceBanner';

const meta: Meta<typeof InsufficientBalanceBanner> = {
  title: 'Shared/InsufficientBalanceBanner',
  component: InsufficientBalanceBanner,
  tags: ['autodocs'],
  parameters: {
    layout: 'padded',
  },
  argTypes: {
    balance: {
      control: { type: 'number', min: 0, max: 1, step: 0.01 },
      description: 'Current balance in dollars',
    },
    colorScheme: {
      control: 'select',
      options: ['warning', 'info'],
      description: 'Color scheme for the banner',
    },
    variant: {
      control: 'select',
      options: ['default', 'compact'],
      description: 'Visual variant of the banner',
    },
  },
};

export default meta;
type Story = StoryObj<typeof InsufficientBalanceBanner>;

export const Default: Story = {
  args: {
    balance: 0.5,
    content: { type: 'productName', productName: 'App Builder' },
    variant: 'default',
  },
};

export const Compact: Story = {
  args: {
    balance: 0.25,
    content: { type: 'productName', productName: 'App Builder' },
    variant: 'compact',
  },
};

export const CloudAgent: Story = {
  args: {
    balance: 0.75,
    content: { type: 'productName', productName: 'Cloud Agent' },
    variant: 'default',
  },
};

export const CloudAgentCompact: Story = {
  args: {
    balance: 0.1,
    content: { type: 'productName', productName: 'Cloud Agent' },
    variant: 'compact',
  },
};

export const ZeroBalance: Story = {
  args: {
    balance: 0,
    content: { type: 'productName', productName: 'App Builder' },
    variant: 'default',
  },
};

export const NegativeBalance: Story = {
  args: {
    balance: -0.5,
    content: { type: 'productName', productName: 'Cloud Agent' },
    variant: 'default',
  },
};

export const InfoColorScheme: Story = {
  args: {
    balance: 0.5,
    colorScheme: 'info',
    content: {
      type: 'custom',
      title: 'Free Models Available',
      description:
        'You can use free models to build your app. Add credits to unlock all models and advanced features.',
      compactActionText: 'Add credits to unlock all models',
    },
    variant: 'default',
  },
};

export const InfoColorSchemeCompact: Story = {
  args: {
    balance: 0.25,
    colorScheme: 'info',
    content: {
      type: 'custom',
      title: 'Free Models Only',
      description:
        'You can use free models to build your app. Add credits to unlock all models and advanced features.',
      compactActionText: 'Add credits to unlock all models',
    },
    variant: 'compact',
  },
};
