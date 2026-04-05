'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command';
import { ChevronsUpDown, Check, Brain } from 'lucide-react';
import { cn } from '@/lib/utils';
import { thinkingEffortLabel } from '@/lib/code-reviews/core/model-variants';

type VariantComboboxProps = {
  /** Available variant keys for the current model (e.g., ["none","low","medium","high","max"]) */
  variants: string[];
  /** Currently selected variant key */
  value?: string;
  /** Called when the user selects a variant */
  onValueChange: (value: string) => void;
  /** Whether the combobox is disabled */
  disabled?: boolean;
  /** Visual variant — only compact is supported */
  variant?: 'compact';
  /** Optional className for the trigger button */
  className?: string;
};

export function VariantCombobox({
  variants,
  value,
  onValueChange,
  disabled = false,
  className,
}: VariantComboboxProps) {
  const [open, setOpen] = useState(false);

  if (variants.length === 0) return null;

  const selectedLabel = value ? thinkingEffortLabel(value) : 'Variant';

  return (
    <Popover open={disabled ? false : open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          className={cn('h-9 justify-between gap-1.5', className)}
        >
          <Brain className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="flex-1 truncate text-left">{selectedLabel}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-44 p-0" align="start">
        <Command>
          <CommandList className="max-h-64 overflow-auto">
            <CommandGroup>
              {variants.map(v => (
                <CommandItem
                  key={v}
                  value={v}
                  onSelect={() => {
                    onValueChange(v);
                    setOpen(false);
                  }}
                  className="flex items-center gap-2"
                >
                  <span className="truncate">{thinkingEffortLabel(v)}</span>
                  <Check
                    className={cn(
                      'ml-auto h-4 w-4 shrink-0',
                      v === value ? 'opacity-100' : 'opacity-0'
                    )}
                  />
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
