'use client';

import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PlatformOption } from './platforms';

type PlatformTileProps = {
  option: PlatformOption;
  selected: boolean;
  onSelect: () => void;
};

export function PlatformTile({ option, selected, onSelect }: PlatformTileProps) {
  const Icon = option.icon;
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        'group relative flex h-32 flex-col items-center justify-center gap-3 rounded-xl border bg-card text-card-foreground',
        'transition-[background-color,border-color,transform] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)]',
        'hover:bg-accent/40 active:scale-[0.99]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
        selected
          ? 'border-primary/70 ring-1 ring-primary/40 bg-primary/5'
          : 'border-border hover:border-border/80'
      )}
    >
      <Icon className="size-9" />
      <span className="text-sm font-medium">{option.name}</span>
      <span
        aria-hidden="true"
        className={cn(
          'absolute right-2.5 top-2.5 grid size-5 place-items-center rounded-full transition-opacity duration-150',
          selected ? 'bg-primary text-primary-foreground opacity-100' : 'opacity-0'
        )}
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
    </button>
  );
}
