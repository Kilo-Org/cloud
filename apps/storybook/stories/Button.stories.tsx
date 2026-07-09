import type { Meta, StoryObj } from '@storybook/nextjs';
import { ArrowRight, LoaderCircle, Search, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';

const meta: Meta<typeof Button> = {
  title: 'Components/Actions/Button',
  component: Button,
  parameters: {
    layout: 'centered',
  },
  args: {
    children: 'Button',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

const variants = [
  'default',
  'primary',
  'brand',
  'secondary',
  'outline',
  'ghost',
  'destructive',
  'link',
] as const;

const sizes = ['sm', 'default', 'lg', 'icon'] as const;

function StorySurface({ children }: { children: React.ReactNode }) {
  return (
    <div className="storybook-canvas flex min-w-80 items-center justify-center p-6">{children}</div>
  );
}

export const Default: Story = {
  args: {
    children: 'Create workspace',
  },
};

export const Variants: Story = {
  render: () => (
    <StorySurface>
      <div className="flex flex-wrap items-center gap-3">
        {variants.map(variant => (
          <Button key={variant} variant={variant}>
            {variant === 'default' ? 'Default' : variant}
          </Button>
        ))}
      </div>
    </StorySurface>
  ),
};

export const Sizes: Story = {
  render: () => (
    <StorySurface>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="sm">Small</Button>
        <Button size="default">Default</Button>
        <Button size="lg">Large</Button>
        <Button size="icon" aria-label="Search repositories">
          <Search />
        </Button>
      </div>
    </StorySurface>
  ),
};

export const InteractionStates: Story = {
  render: () => (
    <StorySurface>
      <div className="flex flex-wrap items-center gap-3">
        <Button>Default</Button>
        <Button className="bg-primary-hover">Hover</Button>
        <Button className="ring-ring ring-[3px]">Focus visible</Button>
        <Button className="bg-primary-hover">Active</Button>
        <Button disabled>Disabled</Button>
        <Button disabled aria-busy="true">
          <LoaderCircle className="animate-spin motion-reduce:animate-none" />
          Saving changes
        </Button>
      </div>
    </StorySurface>
  ),
};

export const LongLabels: Story = {
  render: () => (
    <StorySurface>
      <div className="grid w-full max-w-80 gap-3">
        <Button className="w-full overflow-hidden text-ellipsis">
          Create organization workspace with spending controls
        </Button>
        <Button variant="secondary" className="w-full whitespace-normal text-center leading-snug">
          Review detailed usage for organization seats before renewal
        </Button>
      </div>
    </StorySurface>
  ),
};

export const AccessibleIconButtons: Story = {
  render: () => (
    <StorySurface>
      <div className="flex flex-wrap items-center gap-3">
        <Button size="icon" aria-label="Search repositories">
          <Search />
        </Button>
        <Button size="icon" variant="secondary" aria-label="Open settings">
          <Settings />
        </Button>
        <Button size="icon" variant="outline" aria-label="Continue setup">
          <ArrowRight />
        </Button>
      </div>
    </StorySurface>
  ),
};

export const ReducedMotion: Story = {
  render: () => (
    <StorySurface>
      <div className="storybook-motion-sample flex flex-wrap items-center gap-3">
        {sizes.map(size => (
          <Button key={size} size={size} aria-busy={size !== 'icon'}>
            {size === 'icon' ? (
              <LoaderCircle className="animate-spin motion-reduce:animate-none" />
            ) : (
              <>
                <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                {size} loading
              </>
            )}
          </Button>
        ))}
      </div>
    </StorySurface>
  ),
};
