import type { Meta, StoryObj } from '@storybook/nextjs';
import type { ComponentProps } from 'react';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

const meta: Meta<typeof Input> = {
  title: 'Components/Forms/Input',
  component: Input,
  parameters: {
    layout: 'centered',
  },
};

export default meta;
type Story = StoryObj<typeof meta>;

type FieldProps = Omit<ComponentProps<typeof Input>, 'className'> & {
  label: string;
  description?: string;
  error?: string;
  inputClassName?: string;
  wrapperClassName?: string;
};

function Field({
  id,
  label,
  description,
  error,
  inputClassName,
  wrapperClassName = 'w-80 max-w-full',
  ...props
}: FieldProps) {
  const descriptionId = description ? `${id}-description` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [props['aria-describedby'], descriptionId, errorId].filter(Boolean).join(' ');

  return (
    <div className={`${wrapperClassName} space-y-2`}>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        className={inputClassName}
        aria-describedby={describedBy || undefined}
        aria-invalid={Boolean(error) || props['aria-invalid']}
        {...props}
      />
      {description ? (
        <p id={descriptionId} className="type-label text-muted-foreground">
          {description}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="type-label text-status-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function StorySurface({ children }: { children: React.ReactNode }) {
  return <div className="storybook-canvas grid min-w-80 place-items-center p-6">{children}</div>;
}

export const Default: Story = {
  render: () => (
    <StorySurface>
      <Field
        id="email-default"
        label="Email"
        type="email"
        placeholder="you@example.com"
        autoComplete="email"
      />
    </StorySurface>
  ),
};

export const Disabled: Story = {
  render: () => (
    <StorySurface>
      <Field
        id="workspace-disabled"
        label="Workspace slug"
        type="text"
        value="acme-platform"
        disabled
        readOnly
      />
    </StorySurface>
  ),
};

export const FocusVisible: Story = {
  render: () => (
    <StorySurface>
      <Field
        id="email-focus"
        label="Billing email"
        type="email"
        value="billing@example.com"
        readOnly
        inputClassName="border-ring ring-ring/50 ring-[3px]"
        description="Focus ring uses canonical brand ring token."
      />
    </StorySurface>
  ),
};

export const Invalid: Story = {
  render: () => (
    <StorySurface>
      <Field
        id="email-invalid"
        label="Email"
        type="email"
        value="billing"
        error="Email must include an @ symbol. Example: you@example.com"
        readOnly
      />
    </StorySurface>
  ),
};

export const Loading: Story = {
  render: () => (
    <StorySurface>
      <Field
        id="repository-loading"
        label="Repository"
        type="text"
        value="Loading repositories..."
        disabled
        readOnly
        aria-busy="true"
        description="Disabled state prevents edits while data loads."
      />
    </StorySurface>
  ),
};

export const LongLabels: Story = {
  render: () => (
    <StorySurface>
      <Field
        id="long-label"
        label="Organization billing contact email used for invoices and renewal notices"
        type="email"
        placeholder="billing@example.com"
        autoComplete="email"
        wrapperClassName="w-96 max-w-full"
        description="Visible label remains associated with the input through htmlFor and id."
      />
    </StorySurface>
  ),
};
