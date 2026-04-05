'use client';

import { cn } from '@/lib/utils';

export function Slider({
  min,
  max,
  value,
  onValueChange,
  step = 1,
  className,
}: {
  min: number;
  max: number;
  value: number[];
  onValueChange: (value: number[]) => void;
  step?: number;
  className?: string;
}) {
  return (
    <input
      type="range"
      min={min}
      max={max}
      step={step}
      value={value[0] || min}
      onChange={e => onValueChange([+e.target.value])}
      className={cn(
        '[&::-webkit-slider-thumb]:bg-primary [&::-moz-range-thumb]:bg-primary h-2 w-full cursor-pointer appearance-none rounded-lg bg-gray-200 [&::-moz-range-thumb]:h-4 [&::-moz-range-thumb]:w-4 [&::-moz-range-thumb]:cursor-pointer [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-webkit-slider-thumb]:h-4 [&::-webkit-slider-thumb]:w-4 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full',
        className
      )}
    />
  );
}
