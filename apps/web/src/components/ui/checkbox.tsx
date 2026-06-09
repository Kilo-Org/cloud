'use client';

import * as React from 'react';
import { cn } from '@/lib/utils';

interface CheckboxProps extends Omit<
  React.InputHTMLAttributes<HTMLInputElement>,
  'type' | 'checked'
> {
  checked?: boolean | 'indeterminate';
  onCheckedChange?: (checked: boolean) => void;
}

const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ className, checked, onCheckedChange, onChange, ...props }, ref) => {
    const innerRef = React.useRef<HTMLInputElement>(null);
    React.useImperativeHandle(ref, () => innerRef.current as HTMLInputElement, []);

    // Native HTML checkboxes expose `indeterminate` only as a DOM property,
    // not as a JSX attribute, so we apply it imperatively when the prop
    // resolves to 'indeterminate'.
    React.useEffect(() => {
      if (innerRef.current) {
        innerRef.current.indeterminate = checked === 'indeterminate';
      }
    }, [checked]);

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      onCheckedChange?.(e.target.checked);
      onChange?.(e);
    };

    return (
      <input
        type="checkbox"
        ref={innerRef}
        checked={checked === true}
        onChange={handleChange}
        className={cn(
          'border-input accent-secondary h-4 w-4 rounded bg-input/30 text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      />
    );
  }
);

Checkbox.displayName = 'Checkbox';

export { Checkbox };
