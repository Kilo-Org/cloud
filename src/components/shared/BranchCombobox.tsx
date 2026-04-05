'use client';

import { useRef, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { ChevronsUpDown, Check, GitBranch } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';

export type BranchOption = {
  name: string;
  isDefault: boolean;
};

export type BranchComboboxProps = {
  label?: string;
  helperText?: string;
  branches: BranchOption[];
  value?: string;
  onValueChange: (value: string) => void;
  isLoading?: boolean;
  error?: string;
  placeholder?: string;
  searchPlaceholder?: string;
  noResultsText?: string;
  emptyStateText?: string;
  loadingText?: string;
  required?: boolean;
  hideLabel?: boolean;
};

export function BranchCombobox({
  label = 'Branch',
  helperText = 'Select the branch you want to deploy',
  branches,
  value,
  onValueChange,
  isLoading,
  error,
  placeholder = 'Select a branch',
  searchPlaceholder = 'Search branches...',
  noResultsText = 'No branches match your search',
  emptyStateText = 'No branches available',
  loadingText = 'Loading branches...',
  required = true,
  hideLabel = false,
}: BranchComboboxProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  if (isLoading) {
    return (
      <div className="space-y-2">
        {!hideLabel && (
          <Label>
            {label} {required && <span className="text-red-400">*</span>}
          </Label>
        )}
        <Skeleton className="h-9 w-full" />
        <p className="text-muted-foreground text-xs">{loadingText}</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-2">
        {!hideLabel && (
          <Label>
            {label} {required && <span className="text-red-400">*</span>}
          </Label>
        )}
        <div className="rounded-md border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm text-red-400">
          Failed to load branches: {error}
        </div>
        <p className="text-xs text-gray-500">Please check your settings and try again</p>
      </div>
    );
  }

  if (!branches || branches.length === 0) {
    return (
      <div className="space-y-2">
        {!hideLabel && (
          <Label>
            {label} {required && <span className="text-red-400">*</span>}
          </Label>
        )}
        <div className="rounded-md border border-gray-600 bg-gray-800/50 px-3 py-2 text-sm text-gray-400">
          {emptyStateText}
        </div>
        <p className="text-muted-foreground text-xs">
          No branches are available for this repository
        </p>
      </div>
    );
  }

  const selectedBranch = branches.find(branch => branch.name === value);

  return (
    <div className="space-y-2">
      {!hideLabel && (
        <Label htmlFor="branch-combobox">
          {label} {required && <span className="text-red-400">*</span>}
        </Label>
      )}
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id="branch-combobox"
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            className="w-full justify-between font-mono"
            ref={triggerRef}
          >
            <span className="flex items-center gap-2 truncate">
              <GitBranch className="size-4 text-gray-500" />
              {selectedBranch ? (
                <>
                  {selectedBranch.name}
                  {selectedBranch.isDefault && (
                    <Badge variant="secondary" className="ml-1 text-xs">
                      default
                    </Badge>
                  )}
                </>
              ) : (
                placeholder
              )}
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="p-0"
          align="start"
          style={{ width: triggerRef.current?.offsetWidth }}
        >
          <Command>
            <CommandInput placeholder={searchPlaceholder} />
            <CommandEmpty>{noResultsText}</CommandEmpty>
            <CommandList className="max-h-64 overflow-auto">
              <CommandGroup>
                {branches.map(branch => (
                  <CommandItem
                    key={branch.name}
                    value={branch.name}
                    onSelect={currentValue => {
                      onValueChange(currentValue);
                      setOpen(false);
                    }}
                    className="flex items-center gap-2"
                  >
                    <GitBranch className="size-3.5 text-gray-500" />
                    <span className="truncate">{branch.name}</span>
                    {branch.isDefault && (
                      <Badge variant="secondary" className="ml-1 text-xs">
                        default
                      </Badge>
                    )}
                    <Check
                      className={cn(
                        'ml-auto h-4 w-4',
                        branch.name === value ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {helperText && <p className="text-muted-foreground text-xs">{helperText}</p>}
    </div>
  );
}
