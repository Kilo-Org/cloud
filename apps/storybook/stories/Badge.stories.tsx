import type { Meta, StoryObj } from '@storybook/nextjs';
import { CheckCircle2, Clock3, ExternalLink, ShieldAlert } from 'lucide-react';
import { Badge } from '@/components/ui/badge';

const meta: Meta<typeof Badge> = {
  title: 'Components/Data Display/Badge',
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

const variants = [
  'default',
  'secondary',
  'secondary-outline',
  'destructive',
  'outline',
  'beta',
  'new',
] as const;

function StorySurface({ children }: { children: React.ReactNode }) {
  return (
    <div className="storybook-canvas flex min-w-80 items-center justify-center p-6">{children}</div>
  );
}

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
    <StorySurface>
      <div className="flex flex-wrap gap-2">
        {variants.map(variant => (
          <Badge key={variant} variant={variant}>
            {variant}
          </Badge>
        ))}
      </div>
    </StorySurface>
  ),
};

export const WithIcons: Story = {
  render: () => (
    <StorySurface>
      <div className="flex flex-wrap gap-2">
        <Badge variant="new">
          <CheckCircle2 />
          Active
        </Badge>
        <Badge variant="secondary">
          <Clock3 />
          Pending
        </Badge>
        <Badge variant="destructive">
          <ShieldAlert />
          Action needed
        </Badge>
      </div>
    </StorySurface>
  ),
};

export const LongLabels: Story = {
  render: () => (
    <StorySurface>
      <div className="flex w-80 max-w-full flex-wrap gap-2">
        <Badge className="max-w-full whitespace-normal text-center">
          Organization admin approval required
        </Badge>
        <Badge variant="secondary-outline" className="max-w-full whitespace-normal text-center">
          Usage threshold review scheduled
        </Badge>
      </div>
    </StorySurface>
  ),
};

export const FocusableLink: Story = {
  render: () => (
    <StorySurface>
      <Badge asChild variant="outline">
        <a
          href="#billing-history"
          className="ring-ring ring-[3px]"
          aria-label="View billing history"
        >
          View billing history
          <ExternalLink />
        </a>
      </Badge>
    </StorySurface>
  ),
};
