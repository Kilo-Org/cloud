import type { Meta, StoryObj } from '@storybook/nextjs';
import { Badge } from '@/components/ui/badge';

const meta: Meta<typeof Badge> = {
  title: 'Components/Badge',
  component: Badge,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
  args: {
    children: 'Badge',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: 'Default',
  },
};

export const Secondary: Story = {
  args: {
    variant: 'secondary',
    children: 'Secondary',
  },
};

export const SecondaryOutline: Story = {
  args: {
    variant: 'secondary-outline',
    children: 'Secondary Outline',
  },
};

export const Destructive: Story = {
  args: {
    variant: 'destructive',
    children: 'Destructive',
  },
};

export const Outline: Story = {
  args: {
    variant: 'outline',
    children: 'Outline',
  },
};

export const Beta: Story = {
  args: {
    variant: 'beta',
    children: 'beta',
  },
};

export const BetaUppercase: Story = {
  args: {
    variant: 'beta',
    children: 'BETA',
  },
};

export const AllVariants: Story = {
  render: () => (
    <div className="flex flex-wrap gap-2">
      <Badge>Default</Badge>
      <Badge variant="secondary">Secondary</Badge>
      <Badge variant="secondary-outline">Secondary Outline</Badge>
      <Badge variant="destructive">Destructive</Badge>
      <Badge variant="outline">Outline</Badge>
      <Badge variant="beta">beta</Badge>
    </div>
  ),
};
