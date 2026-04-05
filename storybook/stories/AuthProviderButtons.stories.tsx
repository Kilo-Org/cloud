import type { Meta, StoryObj } from '@storybook/nextjs';
import { AuthProviderButtons } from '@/components/auth/sign-in/AuthProviderButtons';

const meta: Meta<typeof AuthProviderButtons> = {
  title: 'Auth/AuthProviderButtons',
  component: AuthProviderButtons,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    Story => (
      <div className="mx-auto w-full max-w-md space-y-4">
        <Story />
      </div>
    ),
  ],
  args: {
    providers: ['google', 'github', 'gitlab', 'linkedin', 'email'],
    onProviderClick: provider => {
      console.log('Provider clicked:', provider);
    },
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
