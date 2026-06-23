import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';

import { cn } from '@/lib/utils';
import { buttonVariants, type ButtonVariantProps } from './button-variants';

export type ButtonProps = React.ComponentPropsWithRef<'button'> &
  ButtonVariantProps & {
    asChild?: boolean;
  };

function Button({ className, variant, size, asChild = false, ref, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : 'button';
  return <Comp className={cn(buttonVariants({ variant, size }), className)} ref={ref} {...props} />;
}

export { Button };
