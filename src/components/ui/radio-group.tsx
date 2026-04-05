'use client';

import * as React from 'react';
import { Circle } from 'lucide-react';
import { cn } from '@/lib/utils';

type RadioGroupProps = {
  value?: string;
  onValueChange?: (value: string) => void;
  className?: string;
  children: React.ReactNode;
};

const RadioGroupContext = React.createContext<{
  value?: string;
  onValueChange?: (value: string) => void;
}>({});

export function RadioGroup({ value, onValueChange, className, children }: RadioGroupProps) {
  return (
    <RadioGroupContext.Provider value={{ value, onValueChange }}>
      <div className={cn('grid gap-2', className)}>{children}</div>
    </RadioGroupContext.Provider>
  );
}

type RadioGroupItemProps = {
  value: string;
  id?: string;
  className?: string;
  disabled?: boolean;
};

export function RadioGroupItem({ value, id, className, disabled }: RadioGroupItemProps) {
  const { value: selectedValue, onValueChange } = React.useContext(RadioGroupContext);
  const isSelected = selectedValue === value;

  return (
    <button
      type="button"
      role="radio"
      aria-checked={isSelected}
      id={id}
      disabled={disabled}
      onClick={() => !disabled && onValueChange?.(value)}
      className={cn(
        'border-primary text-primary ring-offset-background focus-visible:ring-ring relative flex aspect-square h-4 w-4 items-center justify-center rounded-full border focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
        className
      )}
    >
      {isSelected && <Circle className="h-2.5 w-2.5 fill-current text-current" />}
    </button>
  );
}
