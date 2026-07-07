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
import { BookOpenCheck, Brain, ChevronsUpDown, Check, Image } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  buildModelOptionGroups,
  getModelOptionKeywords,
  type ModelOption,
  type ModelOptionGroup,
} from './model-combobox-options';

export type { ModelOption };
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatShortModelDisplayName } from '@/lib/format-model-name';
import {
  BYOK_MODEL_LABEL,
  FREE_MODEL_DATA_LABEL,
  FREE_MODEL_FREE_LABEL,
  getFreeModelDataTooltip,
  hasUserByokAvailable,
  isFreeModelOption,
  mayTrainOnYourPrompts,
} from '@/components/shared/free-model-data-disclosure';

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
  /** Optional model option rendered above grouped models without an id subtitle. */
  pinnedModel?: ModelOption;
  /**
   * Render the popover as a modal layer. Required when the combobox is
   * itself inside a Radix Dialog — without this, the dialog's focus/pointer
   * scope intercepts wheel events on the portaled popover and the list
   * cannot be scrolled.
   */
  modal?: boolean;
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
  pinnedModel,
  modal = false,
}: ModelComboboxProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const handleSearchChange = useCallback(() => {
    listRef.current?.scrollTo({ top: 0 });
  }, []);

  const modelGroups = useMemo(() => buildModelOptionGroups(models), [models]);

  const selectedModel = [pinnedModel, ...models].find(model => model?.id === value);
  const isCompact = variant === 'compact';
  const showLabel = !isCompact && label;
  const selectedCollectsData =
    selectedModel?.showGatewayMetadata !== false && mayTrainOnYourPrompts(selectedModel);

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

  if ((!models || models.length === 0) && !pinnedModel) {
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
      <Popover
        open={disabled ? false : open}
        onOpenChange={disabled ? undefined : setOpen}
        modal={modal}
      >
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
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate">
                {selectedModel ? formatShortModelDisplayName(selectedModel.name) : placeholder}
              </span>
              {selectedCollectsData && <FreeModelDataIcon />}
            </span>
            <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[min(24rem,calc(100vw-2rem))] p-0" align="start">
          <Command>
            <CommandInput placeholder={searchPlaceholder} onValueChange={handleSearchChange} />
            <CommandEmpty>{noResultsText}</CommandEmpty>
            <CommandList ref={listRef} className="max-h-64 overflow-auto">
              {pinnedModel && (
                <PinnedModelOption
                  model={pinnedModel}
                  value={value}
                  onSelect={modelId => {
                    onValueChange(modelId);
                    setOpen(false);
                  }}
                />
              )}
              <ModelOptionGroups
                groups={modelGroups}
                value={value}
                onSelect={modelId => {
                  onValueChange(modelId);
                  setOpen(false);
                }}
              />
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
      <Popover
        open={disabled ? false : open}
        onOpenChange={disabled ? undefined : setOpen}
        modal={modal}
      >
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
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate">
                {selectedModel ? selectedModel.name : placeholder}
              </span>
              {selectedCollectsData && <FreeModelDataIcon />}
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
            <CommandInput placeholder={searchPlaceholder} onValueChange={handleSearchChange} />
            <CommandEmpty>{noResultsText}</CommandEmpty>
            <CommandList ref={listRef} className="max-h-64 overflow-auto">
              {pinnedModel && (
                <PinnedModelOption
                  model={pinnedModel}
                  value={value}
                  onSelect={modelId => {
                    onValueChange(modelId);
                    setOpen(false);
                  }}
                />
              )}
              <ModelOptionGroups
                groups={modelGroups}
                value={value}
                onSelect={modelId => {
                  onValueChange(modelId);
                  setOpen(false);
                }}
              />
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      {!isCompact && helperText && <p className="text-muted-foreground text-xs">{helperText}</p>}
    </div>
  );
}

function PinnedModelOption({
  model,
  value,
  onSelect,
}: {
  model: ModelOption;
  value?: string;
  onSelect: (value: string) => void;
}) {
  return (
    <CommandGroup>
      <CommandItem
        key={model.id}
        value={`${model.name} ${model.id}`}
        keywords={getModelOptionKeywords(model)}
        onSelect={() => onSelect(model.id)}
        className="flex items-center gap-2"
      >
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate">{model.name}</span>
            {model.showGatewayMetadata !== false && <ModelMetadataBadges model={model} />}
          </div>
        </div>
        <Check
          className={cn(
            'ml-auto h-4 w-4 shrink-0',
            model.id === value ? 'opacity-100' : 'opacity-0'
          )}
        />
      </CommandItem>
    </CommandGroup>
  );
}

function ModelOptionGroups({
  groups,
  value,
  onSelect,
}: {
  groups: ModelOptionGroup[];
  value?: string;
  onSelect: (value: string) => void;
}) {
  return groups.map(group => (
    <CommandGroup key={group.id} heading={group.heading}>
      {group.models.map(model => {
        const keywords = getModelOptionKeywords(model);
        return (
          <CommandItem
            key={model.id}
            value={keywords.join(' ')}
            keywords={keywords}
            disabled={model.unavailable}
            onSelect={() => onSelect(model.id)}
            className="flex items-center gap-2"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center gap-1.5">
                <span className="truncate">{model.name}</span>
                {model.supportsVision === true && (
                  <RowIconHint icon={Image} label="Supports vision" />
                )}
                {model.supportsReasoning === true && (
                  <RowIconHint icon={Brain} label="Supports reasoning" />
                )}
                {model.showGatewayMetadata !== false && <ModelMetadataBadges model={model} />}
                {model.unavailable && (
                  <span className="border-border bg-muted text-muted-foreground inline-flex shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium">
                    Unavailable
                  </span>
                )}
              </div>
              <span className="text-muted-foreground truncate text-xs">
                {model.displayId ?? model.id}
              </span>
            </div>
            <Check
              className={cn(
                'ml-auto h-4 w-4 shrink-0',
                model.id === value ? 'opacity-100' : 'opacity-0'
              )}
            />
          </CommandItem>
        );
      })}
    </CommandGroup>
  ));
}

/**
 * Row-level icon hint used in the model list. Options can number in the
 * hundreds (a CLI's full connected-provider catalog), and Radix's Tooltip
 * mounts a Portal-backed component tree per instance, so using it here makes
 * opening the list itself slow. A native `title` gives the same hover text
 * for a single lightweight span.
 */
function RowIconHint({ icon: Icon, label }: { icon: typeof Image; label: string }) {
  return (
    <span title={label} aria-label={label} className="inline-flex shrink-0 items-center">
      <Icon className="text-muted-foreground h-3.5 w-3.5 shrink-0" />
    </span>
  );
}

function FreeModelDataIcon({ compact = false }: { compact?: boolean }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={FREE_MODEL_DATA_LABEL}
          className="inline-flex shrink-0 items-center rounded-sm text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          role="img"
          tabIndex={0}
        >
          <BookOpenCheck className={compact ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
        </span>
      </TooltipTrigger>
      <TooltipContent>{getFreeModelDataTooltip()}</TooltipContent>
    </Tooltip>
  );
}

function ModelMetadataBadges({ model }: { model: ModelOption }) {
  const free = isFreeModelOption(model);
  const byok = hasUserByokAvailable(model);
  const collectsData = mayTrainOnYourPrompts(model);

  if (!free && !byok && !collectsData) return null;

  return (
    <span className="inline-flex shrink-0 items-center gap-1">
      {free && !byok && (
        <span className="inline-flex shrink-0 items-center rounded-full bg-green-500/20 px-1.5 py-0.5 text-[10px] font-medium text-green-400 ring-1 ring-green-500/20">
          {FREE_MODEL_FREE_LABEL}
        </span>
      )}
      {byok && (
        <span className="bg-muted text-muted-foreground ring-border inline-flex shrink-0 items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1">
          {BYOK_MODEL_LABEL}
        </span>
      )}
      {collectsData && (
        <span
          title={getFreeModelDataTooltip()}
          aria-label={FREE_MODEL_DATA_LABEL}
          className="inline-flex shrink-0 items-center rounded-sm text-foreground"
        >
          <BookOpenCheck className="h-3 w-3" />
        </span>
      )}
    </span>
  );
}
