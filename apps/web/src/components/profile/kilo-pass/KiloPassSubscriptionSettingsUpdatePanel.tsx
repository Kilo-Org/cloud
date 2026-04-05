import { Check, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KiloPassCadence, KiloPassTier } from '@/lib/kilo-pass/enums';
import { cn } from '@/lib/utils';

import { getTierName } from './utils';

const TIERS: KiloPassTier[] = [KiloPassTier.Tier19, KiloPassTier.Tier49, KiloPassTier.Tier199];

const CADENCES: KiloPassCadence[] = [KiloPassCadence.Monthly, KiloPassCadence.Yearly];

type UpdateSummary = {
  title: string;
  body: string;
};

type UpdatePanelProps = {
  currentTierLabel: string;
  currentCadenceLabel: string;
  currentPriceLabel: string;
  newPriceLabel: string;
  targetTier: KiloPassTier;
  targetCadence: KiloPassCadence;
  isMutating: boolean;
  updateSummary: UpdateSummary;
  hasScheduledChange: boolean;
  effectiveAtLabel: string | null;
  onSelectTier: (tier: KiloPassTier) => void;
  onSelectCadence: (cadence: KiloPassCadence) => void;
};

export function UpdatePanel(props: UpdatePanelProps) {
  const {
    currentTierLabel,
    currentCadenceLabel,
    currentPriceLabel,
    newPriceLabel,
    targetTier,
    targetCadence,
    isMutating,
    updateSummary,
    hasScheduledChange,
    effectiveAtLabel,
    onSelectTier,
    onSelectCadence,
  } = props;

  return (
    <div className="grid gap-4">
      <div className="bg-muted/20 border-border/60 rounded-lg border px-3 py-2">
        <div className="text-sm font-semibold">Current plan</div>
        <div className="text-muted-foreground text-sm">
          {currentTierLabel} · {currentCadenceLabel}
        </div>
        <div className="text-sm font-semibold text-white">{currentPriceLabel}</div>
      </div>

      <div className="bg-muted/20 border-border/60 rounded-lg border px-3 py-2">
        <div className="text-sm font-semibold">New plan</div>
        <div className="text-muted-foreground text-sm">
          {getTierName(targetTier)} · {getCadenceLabel(targetCadence)}
        </div>
        <div className="text-sm font-semibold text-white">{newPriceLabel}</div>
      </div>

      <div className="grid gap-2">
        <div className="text-sm font-medium">Tier</div>
        <div className="grid grid-cols-3 gap-2">
          {TIERS.map(tier => (
            <TierOptionButton
              key={tier}
              tier={tier}
              isSelected={tier === targetTier}
              isDisabled={isMutating}
              onSelect={() => onSelectTier(tier)}
            />
          ))}
        </div>
      </div>

      <div className="grid gap-2">
        <div className="text-sm font-medium">Cadence</div>
        <div className="grid grid-cols-2 gap-2">
          {CADENCES.map(cadence => (
            <CadenceOptionButton
              key={cadence}
              cadence={cadence}
              isSelected={cadence === targetCadence}
              isDisabled={isMutating}
              onSelect={() => onSelectCadence(cadence)}
            />
          ))}
        </div>
      </div>

      <div className="bg-muted/20 border-border/60 grid gap-1 rounded-lg border px-3 py-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">{updateSummary.title}</span>
          {hasScheduledChange ? <Badge variant="secondary">Scheduled</Badge> : null}
        </div>
        <p className="text-muted-foreground text-sm">{updateSummary.body}</p>
      </div>

      {hasScheduledChange && effectiveAtLabel ? (
        <div className="text-muted-foreground text-xs">Scheduled for {effectiveAtLabel}</div>
      ) : null}
    </div>
  );
}

type UpdateFooterProps = {
  onBack: () => void;
  onCancelPendingChange: () => void;
  onScheduleChange: () => void;
  isMutating: boolean;
  hasPendingChange: boolean;
  isCancelingPendingChange: boolean;
  isSchedulingChange: boolean;
  isSameSelection: boolean;
};

export function UpdateFooter(props: UpdateFooterProps) {
  const {
    onBack,
    onCancelPendingChange,
    onScheduleChange,
    isMutating,
    hasPendingChange,
    isCancelingPendingChange,
    isSchedulingChange,
    isSameSelection,
  } = props;

  return (
    <div className="flex w-full flex-col gap-2 sm:flex-row sm:justify-between">
      <Button variant="outline" onClick={onBack} disabled={isMutating}>
        Back
      </Button>
      <div className="flex flex-1 items-center justify-end gap-2">
        {hasPendingChange ? (
          <Button
            variant="outline"
            onClick={onCancelPendingChange}
            disabled={isCancelingPendingChange}
          >
            {isCancelingPendingChange ? 'Canceling...' : 'Cancel pending change'}
          </Button>
        ) : null}
        {!hasPendingChange ? (
          <Button onClick={onScheduleChange} disabled={isSameSelection || isMutating}>
            {isSchedulingChange ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Check className="mr-2 h-4 w-4" />
            )}
            Schedule change
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function TierOptionButton(props: {
  tier: KiloPassTier;
  isSelected: boolean;
  isDisabled: boolean;
  onSelect: () => void;
}) {
  const { tier, isSelected, isDisabled, onSelect } = props;

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={isDisabled}
      className={cn(
        'border-border/60 rounded-lg border px-3 py-2 text-left text-sm transition',
        'hover:border-blue-400/70 hover:bg-blue-500/10',
        isSelected && 'border-blue-500/70 bg-blue-500/15',
        isDisabled && 'cursor-not-allowed opacity-60'
      )}
    >
      <div className="font-semibold">{getTierName(tier)}</div>
    </button>
  );
}

function CadenceOptionButton(props: {
  cadence: KiloPassCadence;
  isSelected: boolean;
  isDisabled: boolean;
  onSelect: () => void;
}) {
  const { cadence, isSelected, isDisabled, onSelect } = props;
  const label = getCadenceLabel(cadence);

  return (
    <button
      type="button"
      onClick={onSelect}
      disabled={isDisabled}
      className={cn(
        'border-border/60 rounded-lg border px-3 py-2 text-left text-sm transition',
        'hover:border-blue-400/70 hover:bg-blue-500/10',
        isSelected && 'border-blue-500/70 bg-blue-500/15',
        isDisabled && 'cursor-not-allowed opacity-60'
      )}
    >
      <div className="font-semibold">{label}</div>
    </button>
  );
}

export function getCadenceLabel(cadence: KiloPassCadence) {
  return cadence === KiloPassCadence.Monthly ? 'Monthly' : 'Yearly';
}
