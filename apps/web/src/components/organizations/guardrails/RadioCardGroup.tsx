'use client';

import { useId } from 'react';
import { cn } from '@/lib/utils';

type RadioCardOption<T extends string> = {
  value: T;
  label: string;
  description: string;
};

export function RadioCardGroup<T extends string>({
  legend,
  options,
  value,
  onChange,
}: {
  legend: string;
  options: readonly RadioCardOption<T>[];
  value: T;
  onChange: (value: T) => void;
}) {
  const name = useId();
  return (
    <fieldset className="grid gap-3">
      <legend className="mb-3 text-sm font-medium">{legend}</legend>
      <div className="grid gap-3 sm:grid-cols-2">
        {options.map(option => (
          <label
            key={option.value}
            className={cn(
              'hover:bg-muted/40 flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors',
              'has-[:checked]:border-ring has-[:checked]:bg-muted/40',
              'has-[:focus-visible]:ring-ring/50 has-[:focus-visible]:ring-[3px]'
            )}
          >
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={value === option.value}
              onChange={() => onChange(option.value)}
              className="accent-primary mt-0.5 size-4 shrink-0 focus-visible:outline-none"
            />
            <span className="grid gap-1">
              <span className="text-sm font-medium">{option.label}</span>
              <span className="text-muted-foreground text-sm">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}
