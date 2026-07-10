import type { Meta, StoryObj } from '@storybook/nextjs';
import { AccountCreationScreen } from '@/components/auth/AccountCreationScreen';

const meta = {
  title: 'Auth/AccountCreationScreen',
  component: AccountCreationScreen,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof AccountCreationScreen>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Desktop: Story = {
  globals: {
    viewport: { value: 'desktop', isRotated: false },
  },
};

export const Mobile: Story = {
  globals: {
    viewport: { value: 'mobile2', isRotated: false },
  },
};
