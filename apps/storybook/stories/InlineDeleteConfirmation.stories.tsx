import type { Meta, StoryObj } from '@storybook/nextjs';
import { InlineDeleteConfirmation } from '@/components/ui/inline-delete-confirmation';

const meta: Meta<typeof InlineDeleteConfirmation> = {
  title: 'Components/Actions/InlineDeleteConfirmation',
  component: InlineDeleteConfirmation,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const IconButton: Story = {
  args: {
    onDelete: () => undefined,
    warningText: 'This removes the saved token.',
  },
};

export const TextButton: Story = {
  args: {
    onDelete: () => undefined,
    showAsButton: true,
    buttonText: 'Delete token',
    warningText: 'Existing automation cannot use this token after deletion.',
  },
};

export const Loading: Story = {
  args: {
    onDelete: () => undefined,
    showAsButton: true,
    isLoading: true,
    buttonText: 'Delete token',
  },
};
