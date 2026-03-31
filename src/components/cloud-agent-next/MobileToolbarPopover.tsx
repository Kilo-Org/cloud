'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ModeCombobox, NEXT_MODE_OPTIONS } from '@/components/shared/ModeCombobox';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import { formatShortModelDisplayName } from '@/lib/format-model-name';
import type { AgentMode } from './types';

type MobileToolbarPopoverProps = {
  mode?: AgentMode;
  onModeChange?: (mode: AgentMode) => void;
  model?: string;
  modelOptions: ModelOption[];
  onModelChange?: (model: string) => void;
  isLoadingModels?: boolean;
  variant?: string;
  availableVariants?: string[];
  onVariantChange?: (variant: string) => void;
  disabled?: boolean;
  className?: string;
};

export function MobileToolbarPopover({
  mode,
  onModeChange,
  model,
  modelOptions,
  onModelChange,
  isLoadingModels,
  variant,
  availableVariants = [],
  onVariantChange,
  disabled,
  className,
}: MobileToolbarPopoverProps) {
  const [open, setOpen] = useState(false);

  const selectedModel = modelOptions.find(m => m.id === model);
  const displayName = selectedModel
    ? formatShortModelDisplayName(selectedModel.name)
    : 'Select model';

  return (
    <Popover open={disabled ? false : open} onOpenChange={disabled ? undefined : setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn('h-9 min-w-0 justify-between gap-1.5', className)}
        >
          <span className="truncate">{displayName}</span>
          <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className="w-[min(20rem,calc(100vw-2rem))] space-y-3 p-3"
        align="start"
        side="top"
      >
        {onModeChange && (
          <ModeCombobox
            value={mode}
            onValueChange={onModeChange}
            options={NEXT_MODE_OPTIONS}
            label="Mode"
          />
        )}
        {onModelChange && (
          <ModelCombobox
            models={modelOptions}
            value={model}
            onValueChange={onModelChange}
            isLoading={isLoadingModels}
            label="Model"
          />
        )}
        {availableVariants.length > 0 && onVariantChange && (
          <div className="space-y-2">
            <label className="text-sm font-medium">Thinking effort</label>
            <VariantCombobox
              variants={availableVariants}
              value={variant}
              onValueChange={onVariantChange}
              className="w-full"
            />
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
