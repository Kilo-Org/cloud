import * as React from 'react';

import { inputClassName } from '@/components/ui/primitive-classnames';
import { cn } from '@/lib/utils';

type InputProps = React.ComponentProps<'input'>;

function Input({ className, type, ...props }: InputProps) {
  return (
    <input type={type} data-slot="input" className={cn(inputClassName, className)} {...props} />
  );
}

export { Input };
