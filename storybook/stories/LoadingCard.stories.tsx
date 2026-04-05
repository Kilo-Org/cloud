import type { Meta, StoryObj } from '@storybook/nextjs';
import { LoadingCard } from '@/components/LoadingCard';

const meta: Meta<typeof LoadingCard> = {
  title: 'Components/LoadingCard',
  component: LoadingCard,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    title: 'Loading Content',
    description: 'Please wait while we load your data...',
    rowCount: 3,
  },
};
