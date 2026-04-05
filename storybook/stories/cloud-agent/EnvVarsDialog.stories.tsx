import type { Meta, StoryObj } from '@storybook/nextjs';
import { EnvVarsDialog } from '@/components/cloud-agent/EnvVarsDialog';
import { useState } from 'react';

const meta: Meta<typeof EnvVarsDialog> = {
  title: 'Cloud Agent/EnvVarsDialog',
  component: EnvVarsDialog,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

// Wrapper component to handle state
function EnvVarsDialogWrapper({ initialValue }: { initialValue: Record<string, string> }) {
  const [value, setValue] = useState(initialValue);
  return <EnvVarsDialog value={value} onChange={setValue} />;
}

export const Empty: Story = {
  render: () => <EnvVarsDialogWrapper initialValue={{}} />,
};

export const WithExistingVars: Story = {
  render: () => (
    <EnvVarsDialogWrapper
      initialValue={{
        NODE_ENV: 'production',
        API_KEY: 'sk-1234567890abcdef',
        DATABASE_URL: 'postgresql://user:pass@localhost:5432/db',
        REDIS_URL: 'redis://localhost:6379',
        JWT_SECRET: 'your-secret-key-here',
      }}
    />
  ),
};

export const WithFewVars: Story = {
  render: () => (
    <EnvVarsDialogWrapper
      initialValue={{
        API_KEY: 'test-api-key',
        API_URL: 'https://api.example.com',
      }}
    />
  ),
};
