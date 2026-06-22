'use client';

import { Slot } from '@radix-ui/react-slot';
import type { ComponentProps, ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

type SecurityAgentActionBarProps = Omit<ComponentProps<'section'>, 'aria-label'> & {
  label: string;
  asChild?: boolean;
};

export function SecurityAgentActionBar({
  label,
  asChild = false,
  className,
  ...props
}: SecurityAgentActionBarProps) {
  const Component = asChild ? Slot : 'section';

  return (
    <Component
      aria-label={label}
      className={cn('border-border bg-surface-raised rounded-xl border p-3 sm:p-4', className)}
      {...props}
    />
  );
}

export function SecurityAgentActionBarField({
  id,
  label,
  className,
  children,
}: {
  id: string;
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn('grid min-w-0 gap-2', className)}>
      <Label htmlFor={id} className="text-muted-foreground text-xs font-medium leading-none">
        {label}
      </Label>
      {children}
    </div>
  );
}
