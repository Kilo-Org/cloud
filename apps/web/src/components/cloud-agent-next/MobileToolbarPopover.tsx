'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ChevronsUpDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ModeCombobox, NEXT_MODE_OPTIONS, type ModeOption } from '@/components/shared/ModeCombobox';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { VariantCombobox } from '@/components/shared/VariantCombobox';
import { thinkingEffortLabel } from '@/lib/code-reviews/core/model-variants';
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
  /** When set, the model picker is rendered as read-only with this explanatory tooltip. */
  modelPickerDisabled?: boolean;
  modelPickerTooltip?: string;
  /** When set, the variant picker is rendered as read-only with this explanatory tooltip. */
  variantPickerDisabled?: boolean;
  variantPickerTooltip?: string;
  className?: string;
  customModeOptions?: ModeOption[];
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
  modelPickerDisabled,
  modelPickerTooltip,
  variantPickerDisabled,
  variantPickerTooltip,
  className,
  customModeOptions,
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
            customOptions={customModeOptions}
            label="Mode"
          />
        )}
        {onModelChange && (
          <div className="space-y-2">
            <label className="text-sm font-medium">Model</label>
            {modelPickerDisabled ? (
              <div className="text-muted-foreground rounded-md border border-dashed px-2 py-2 text-xs">
                <div className={cn(!selectedModel && 'font-mono')}>
                  {selectedModel ? displayName : model}
                </div>
                {modelPickerTooltip && <div className="mt-1">{modelPickerTooltip}</div>}
              </div>
            ) : (
              <ModelCombobox
                models={modelOptions}
                value={model}
                onValueChange={onModelChange}
                isLoading={isLoadingModels}
                label=""
              />
            )}
          </div>
        )}
        {variantPickerDisabled
          ? variant && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Thinking effort</label>
                <div className="text-muted-foreground rounded-md border border-dashed px-2 py-2 text-xs">
                  <div>{thinkingEffortLabel(variant)}</div>
                  {variantPickerTooltip && <div className="mt-1">{variantPickerTooltip}</div>}
                </div>
              </div>
            )
          : availableVariants.length > 0 &&
            onVariantChange && (
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
