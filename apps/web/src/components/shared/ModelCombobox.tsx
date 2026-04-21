'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
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
import { ChevronsUpDown, Check, Image } from 'lucide-react';
import { cn } from '@/lib/utils';
import { preferredModels } from '@/lib/ai-gateway/models';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortModelDisplayName } from '@/lib/format-model-name';

export type ModelOption = {
  id: string; // e.g., "anthropic/claude-sonnet-4.5"
  name: string; // e.g., "Claude Sonnet 4.5"
  supportsVision?: boolean;
  /** Ordered list of variant key names (e.g., ["none","low","medium","high","max"]) */
  variants?: string[];
};

export type ModelComboboxProps = {
  label?: string;
  helperText?: string;
  models: ModelOption[];
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
  /** Compact variant for inline use (e.g., chat footer) - hides label, helper text, and uses smaller styling */
  variant?: 'full' | 'compact';
  /** Optional className for the trigger button */
  className?: string;
  /** Whether the combobox is disabled */
  disabled?: boolean;
};

export function ModelCombobox({
  label = 'Model',
  helperText,
  models,
  value,
  onValueChange,
  isLoading,
  error,
  placeholder = 'Select a model',
  searchPlaceholder = 'Search models...',
  noResultsText = 'No models match your search',
  emptyStateText = 'No models available',
  loadingText = 'Loading models...',
  required = false,
  variant = 'full',
  className,
  disabled = false,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const handleSearchChange = useCallback(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, []);

  // Sort models: preferred models first (in preferredModels order), then others alphabetically
  // This must be called before any early returns to follow Rules of Hooks
  const sortedModels = useMemo(() => {
    const preferred: ModelOption[] = [];
    const others: ModelOption[] = [];

    models.forEach(model => {
      if (preferredModels.includes(model.id)) {
        preferred.push(model);
      } else {
        others.push(model);
      }
    });

    // Sort preferred by their index in preferredModels array
    preferred.sort((a, b) => {
      return preferredModels.indexOf(a.id) - preferredModels.indexOf(b.id);
    });

    // Sort others alphabetically by name
    others.sort((a, b) => a.name.localeCompare(b.name));

    return { preferred, others };
  }, [models]);

  const selectedModel = models.find(model => model.id === value);
  const isCompact = variant === 'compact';
  const showLabel = !isCompact && label;

  if (isLoading) {
    if (isCompact) {
      return <Skeleton className={cn('h-9 w-40', className)} />;
    }
    return (
      <div className="space-y-2">
        {showLabel && (
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
    if (isCompact) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn('h-9 border-red-400/50 text-red-400', className)}
              disabled
            >
              Error
            </Button>
          </TooltipTrigger>
          <TooltipContent>{error}</TooltipContent>
        </Tooltip>
      );
    }
    return (
      <div className="space-y-2">
        {showLabel && (
          <Label>
            {label} {required && <span className="text-red-400">*</span>}
          </Label>
        )}
        <div className="rounded-md border border-red-400/50 bg-red-400/10 px-3 py-2 text-sm text-red-400">
          {error}
        </div>
      </div>
    );
  }

  if (!models || models.length === 0) {
    if (isCompact) {
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn('text-muted-foreground h-9', className)}
          disabled
        >
          No models
        </Button>
      );
    }
    return (
      <div className="space-y-2">
        {showLabel && (
          <Label>
            {label} {required && <span className="text-red-400">*</span>}
          </Label>
        )}
        <div className="rounded-md border border-gray-600 bg-gray-800/50 px-3 py-2 text-sm text-gray-400">
          {emptyStateText}
        </div>
      </div>
    );
  }

  // Compact variant - just the popover trigger without wrapper
  if (isCompact) {
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
            ref={triggerRef}
          >
            <span className="truncate">
              {selectedModel ? formatShortModelDisplayName(selectedModel.name) : placeholder}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(24rem,calc(100vw-2rem))] p-0" align="start">
          <Command>
            <CommandInput placeholder={searchPlaceholder} onValueChange={handleSearchChange} />
            <CommandEmpty>{noResultsText}</CommandEmpty>
            <CommandList ref={listRef} className="max-h-64 overflow-auto">
              {sortedModels.preferred.length > 0 && (
                <CommandGroup heading="Recommended">
                  {sortedModels.preferred.map(model => (
                    <CommandItem
                      key={model.id}
                      value={`${model.name} ${model.id}`}
                      keywords={[model.id, model.name]}
                      onSelect={() => {
                        onValueChange(model.id);
                        setOpen(false);
                      }}
                      className="flex items-center gap-2"
                    >
                      <div className="flex flex-col truncate">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate">{model.name}</span>
                          {model.supportsVision === true && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Image className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                              </TooltipTrigger>
                              <TooltipContent>Supports vision</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <span className="text-muted-foreground truncate text-xs">{model.id}</span>
                      </div>
                      <Check
                        className={cn(
                          'ml-auto h-4 w-4 shrink-0',
                          model.id === value ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {sortedModels.others.length > 0 && (
                <CommandGroup heading="All Models">
                  {sortedModels.others.map(model => (
                    <CommandItem
                      key={model.id}
                      value={`${model.name} ${model.id}`}
                      keywords={[model.id, model.name]}
                      onSelect={() => {
                        onValueChange(model.id);
                        setOpen(false);
                      }}
                      className="flex items-center gap-2"
                    >
                      <div className="flex flex-col truncate">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate">{model.name}</span>
                          {model.supportsVision === true && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Image className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                              </TooltipTrigger>
                              <TooltipContent>Supports vision</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <span className="text-muted-foreground truncate text-xs">{model.id}</span>
                      </div>
                      <Check
                        className={cn(
                          'ml-auto h-4 w-4 shrink-0',
                          model.id === value ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    );
  }

  return (
    <div className="space-y-2">
      {showLabel && (
        <Label htmlFor="model-combobox">
          {label} {required && <span className="text-red-400">*</span>}
        </Label>
      )}
      <Popover open={disabled ? false : open} onOpenChange={disabled ? undefined : setOpen}>
        <PopoverTrigger asChild>
          <Button
            id="model-combobox"
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className={cn('w-full justify-between', className)}
            ref={triggerRef}
          >
            <span className="truncate">{selectedModel ? selectedModel.name : placeholder}</span>
            <ChevronsUpDown className="ml-2 h-4 w-4 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent
          className="p-0"
          align="start"
          style={{ width: triggerRef.current?.offsetWidth }}
        >
          <Command>
            <CommandInput placeholder={searchPlaceholder} onValueChange={handleSearchChange} />
            <CommandEmpty>{noResultsText}</CommandEmpty>
            <CommandList ref={listRef} className="max-h-64 overflow-auto">
              {sortedModels.preferred.length > 0 && (
                <CommandGroup heading="Recommended">
                  {sortedModels.preferred.map(model => (
                    <CommandItem
                      key={model.id}
                      value={`${model.name} ${model.id}`}
                      keywords={[model.id, model.name]}
                      onSelect={() => {
                        onValueChange(model.id);
                        setOpen(false);
                      }}
                      className="flex items-center gap-2"
                    >
                      <div className="flex flex-col truncate">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate">{model.name}</span>
                          {model.supportsVision === true && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Image className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                              </TooltipTrigger>
                              <TooltipContent>Supports vision</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <span className="text-muted-foreground truncate text-xs">{model.id}</span>
                      </div>
                      <Check
                        className={cn(
                          'ml-auto h-4 w-4 shrink-0',
                          model.id === value ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
              {sortedModels.others.length > 0 && (
                <CommandGroup heading="All Models">
                  {sortedModels.others.map(model => (
                    <CommandItem
                      key={model.id}
                      value={`${model.name} ${model.id}`}
                      keywords={[model.id, model.name]}
                      onSelect={() => {
                        onValueChange(model.id);
                        setOpen(false);
                      }}
                      className="flex items-center gap-2"
                    >
                      <div className="flex flex-col truncate">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate">{model.name}</span>
                          {model.supportsVision === true && (
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <Image className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
                              </TooltipTrigger>
                              <TooltipContent>Supports vision</TooltipContent>
                            </Tooltip>
                          )}
                        </div>
                        <span className="text-muted-foreground truncate text-xs">{model.id}</span>
                      </div>
                      <Check
                        className={cn(
                          'ml-auto h-4 w-4 shrink-0',
                          model.id === value ? 'opacity-100' : 'opacity-0'
                        )}
                      />
                    </CommandItem>
                  ))}
                </CommandGroup>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {!isCompact && helperText && <p className="text-muted-foreground text-xs">{helperText}</p>}
    </div>
  );
}
