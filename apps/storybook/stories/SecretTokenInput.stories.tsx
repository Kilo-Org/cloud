import type { Meta, StoryObj } from '@storybook/nextjs';
import { Label } from '@/components/ui/label';
import { SecretTokenInput } from '@/components/ui/secret-token-input';

const meta: Meta<typeof SecretTokenInput> = {
  title: 'Components/Forms/SecretTokenInput',
  component: SecretTokenInput,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="grid w-[360px] gap-2">
      <Label htmlFor="api-token">API token</Label>
      <SecretTokenInput id="api-token" defaultValue="kilo_live_1234567890abcdef" />
    </div>
  ),
};

export const Disabled: Story = {
  render: () => (
    <div className="grid w-[360px] gap-2">
      <Label htmlFor="disabled-api-token">Disabled token</Label>
      <SecretTokenInput id="disabled-api-token" defaultValue="kilo_live_locked" disabled />
    </div>
  ),
};
