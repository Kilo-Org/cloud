'use client';

import { useMemo, useState } from 'react';
import { CheckCircle2, ChevronDown, Gift, Scale, Zap } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ModelCombobox, type ModelOption } from '@/components/shared/ModelCombobox';
import { cn } from '@/lib/utils';
import {
  KILO_AUTO_BALANCED_MODEL,
  KILO_AUTO_FREE_MODEL,
  KILO_AUTO_FRONTIER_MODEL,
} from '@/lib/kilo-auto-model';

const AUTO_CARD_MODEL_IDS = new Set([
  KILO_AUTO_FRONTIER_MODEL.id,
  KILO_AUTO_BALANCED_MODEL.id,
  KILO_AUTO_FREE_MODEL.id,
]);

type CostLevel = 0 | 1 | 2 | 3;
type PerformanceLevel = 1 | 2 | 3;

type AutoModelCard = {
  id: string;
  label: string;
  description: string;
  icon: typeof Zap;
  iconBg: string;
  iconColor: string;
  cost: CostLevel;
  performance: PerformanceLevel;
  performanceDotColor: string;
};

const autoModelCards: AutoModelCard[] = [
  {
    id: KILO_AUTO_FRONTIER_MODEL.id,
    label: 'Frontier',
    description: KILO_AUTO_FRONTIER_MODEL.description,
    icon: Zap,
    iconBg: 'bg-purple-500/20',
    iconColor: 'text-purple-400',
    cost: 3,
    performance: 3,
    performanceDotColor: 'bg-purple-400',
  },
  {
    id: KILO_AUTO_BALANCED_MODEL.id,
    label: 'Balanced',
    description: KILO_AUTO_BALANCED_MODEL.description,
    icon: Scale,
    iconBg: 'bg-blue-500/20',
    iconColor: 'text-blue-400',
    cost: 2,
    performance: 2,
    performanceDotColor: 'bg-blue-400',
  },
  {
    id: KILO_AUTO_FREE_MODEL.id,
    label: 'Free',
    description: KILO_AUTO_FREE_MODEL.description,
    icon: Gift,
    iconBg: 'bg-emerald-500/20',
    iconColor: 'text-emerald-400',
    cost: 0,
    performance: 1,
    performanceDotColor: 'bg-emerald-400',
  },
];

function CostIndicator({ level }: { level: CostLevel }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-xs">Cost</span>
      <span className="flex gap-0.5 text-sm font-medium tracking-tight">
        {[0, 1, 2].map(i => (
          <span key={i} className={cn(i < level ? 'text-foreground' : 'text-muted-foreground/30')}>
            $
          </span>
        ))}
      </span>
    </div>
  );
}

function PerformanceIndicator({ level, dotColor }: { level: PerformanceLevel; dotColor: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground text-xs">Performance</span>
      <div className="flex gap-1">
        {[0, 1, 2].map(i => (
          <span
            key={i}
            className={cn(
              'h-2.5 w-5 rounded-full',
              i < level ? dotColor : 'bg-muted-foreground/20'
            )}
          />
        ))}
      </div>
    </div>
  );
}

export type AutoModelPickerProps = {
  models: ModelOption[];
  value: string;
  onValueChange: (value: string) => void;
  isLoading?: boolean;
  error?: string;
  disabled?: boolean;
};

export function AutoModelPicker({
  models,
  value,
  onValueChange,
  isLoading,
  error,
  disabled,
}: AutoModelPickerProps) {
  const [moreModelsOpen, setMoreModelsOpen] = useState(false);

  const isAutoModelSelected = AUTO_CARD_MODEL_IDS.has(value);

  const nonAutoModels = useMemo(() => models.filter(m => !AUTO_CARD_MODEL_IDS.has(m.id)), [models]);

  // Filter auto model cards to only those available in the model list
  const availableAutoCards = useMemo(
    () => autoModelCards.filter(card => models.some(m => m.id === card.id)),
    [models]
  );

  function handleCardSelect(modelId: string) {
    if (disabled) return;
    onValueChange(modelId);
    setMoreModelsOpen(false);
  }

  function handleDropdownSelect(modelId: string) {
    onValueChange(modelId);
  }

  return (
    <div className="space-y-4">
      {availableAutoCards.length > 0 && (
        <fieldset className="border-t pt-2">
          <legend className="text-muted-foreground pr-2 text-xs font-semibold tracking-wider uppercase">
            Kilo Auto
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {availableAutoCards.map(card => {
              const selected = value === card.id;
              const Icon = card.icon;
              return (
                <button
                  key={card.id}
                  type="button"
                  disabled={disabled}
                  onClick={() => handleCardSelect(card.id)}
                  className={cn(
                    'relative flex flex-col gap-3 rounded-lg border p-4 text-left transition-colors',
                    'hover:bg-accent/50 focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none',
                    selected ? 'border-blue-500 bg-blue-500/5' : 'border-border',
                    disabled && 'pointer-events-none opacity-50'
                  )}
                >
                  {selected && (
                    <CheckCircle2 className="absolute top-2.5 right-2.5 h-5 w-5 text-blue-500" />
                  )}

                  <div
                    className={cn(
                      'flex h-9 w-9 items-center justify-center rounded-lg',
                      card.iconBg
                    )}
                  >
                    <Icon className={cn('h-5 w-5', card.iconColor)} />
                  </div>

                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold">{card.label}</span>
                    </div>
                    <p className="text-muted-foreground text-xs leading-relaxed">
                      {card.description}
                    </p>
                  </div>

                  <div className="mt-auto space-y-1.5">
                    <CostIndicator level={card.cost} />
                    <PerformanceIndicator
                      level={card.performance}
                      dotColor={card.performanceDotColor}
                    />
                  </div>
                </button>
              );
            })}
          </div>
        </fieldset>
      )}

      <Collapsible open={moreModelsOpen} onOpenChange={setMoreModelsOpen}>
        <div className="flex items-center gap-4">
          <hr className="grow opacity-75" />
          <CollapsibleTrigger
            disabled={disabled}
            className={cn(
              'text-muted-foreground hover:text-foreground flex cursor-pointer items-center justify-center gap-1.5 text-sm transition-colors',
              disabled && 'pointer-events-none opacity-50'
            )}
          >
            or select from 500+ models
            <ChevronDown
              className={cn('h-4 w-4 transition-transform', moreModelsOpen && 'rotate-180')}
            />
          </CollapsibleTrigger>
          <hr className="grow opacity-75" />
        </div>
        <CollapsibleContent className="pt-3">
          <ModelCombobox
            label=""
            models={nonAutoModels}
            value={isAutoModelSelected ? '' : value}
            onValueChange={handleDropdownSelect}
            isLoading={isLoading}
            error={error}
            disabled={disabled}
            placeholder="Search all models..."
          />
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
