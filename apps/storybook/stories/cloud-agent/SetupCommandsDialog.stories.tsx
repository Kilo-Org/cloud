import type { Meta, StoryObj } from '@storybook/nextjs';
import { SetupCommandsDialog } from '@/components/cloud-agent/SetupCommandsDialog';
import { useState } from 'react';

const meta: Meta<typeof SetupCommandsDialog> = {
  title: 'Cloud Agent/SetupCommandsDialog',
  component: SetupCommandsDialog,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
};

export default meta;
type Story = StoryObj<typeof meta>;

// Wrapper component to handle state
function SetupCommandsDialogWrapper({ initialValue }: { initialValue: string[] }) {
  const [value, setValue] = useState(initialValue);
  return <SetupCommandsDialog value={value} onChange={setValue} />;
}

export const Empty: Story = {
  render: () => <SetupCommandsDialogWrapper initialValue={[]} />,
};

export const WithCommands: Story = {
  render: () => (
    <SetupCommandsDialogWrapper
      initialValue={[
        'npm install',
        'pip install -r requirements.txt',
        'cp .env.example .env',
        'npm run build',
      ]}
    />
  ),
};

export const WithFewCommands: Story = {
  render: () => <SetupCommandsDialogWrapper initialValue={['pnpm install', 'pnpm build']} />,
};

export const WithComplexCommands: Story = {
  render: () => (
    <SetupCommandsDialogWrapper
      initialValue={[
        'docker-compose up -d',
        'npm install --legacy-peer-deps',
        'npx prisma migrate deploy',
        'npm run seed:dev',
        'npm run test:e2e',
      ]}
    />
  ),
};
