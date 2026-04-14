'use client';

import { SlidersHorizontal } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

type ConfigLayer = {
  label: string;
  detail?: string;
};

type ProfileConfigIndicatorState = {
  label: 'Profile active' | 'Profiles active' | 'Custom config active' | 'Config needs attention';
  layers: ConfigLayer[];
  needsAttention: boolean;
};

export type BuildProfileConfigIndicatorStateInput = {
  selectedProfileName?: string | null;
  repoBoundProfileName?: string | null;
  hasManualEnvVars: boolean;
  hasManualSetupCommands: boolean;
  hasSelectedProfileId: boolean;
  isProfilesLoading?: boolean;
  hasProfileError?: boolean;
  hasRepoBindingError?: boolean;
};

export function buildProfileConfigIndicatorState({
  selectedProfileName,
  repoBoundProfileName,
  hasManualEnvVars,
  hasManualSetupCommands,
  hasSelectedProfileId,
  isProfilesLoading = false,
  hasProfileError = false,
  hasRepoBindingError = false,
}: BuildProfileConfigIndicatorStateInput): ProfileConfigIndicatorState | null {
  const hasManualConfig = hasManualEnvVars || hasManualSetupCommands;
  const layers: ConfigLayer[] = [];

  if (repoBoundProfileName) {
    layers.push({ label: 'Repo profile', detail: repoBoundProfileName });
  }

  if (selectedProfileName) {
    layers.push({ label: 'Selected profile', detail: selectedProfileName });
  }

  if (hasManualConfig) {
    const manualLayers: string[] = [];
    if (hasManualEnvVars) {
      manualLayers.push('environment variables');
    }
    if (hasManualSetupCommands) {
      manualLayers.push('setup commands');
    }
    layers.push({ label: 'Manual overrides', detail: manualLayers.join(' and ') });
  }

  const selectedProfileNeedsAttention =
    hasSelectedProfileId && !selectedProfileName && !isProfilesLoading;
  const profileNames = new Set<string>();
  if (repoBoundProfileName) {
    profileNames.add(repoBoundProfileName);
  }
  if (selectedProfileName) {
    profileNames.add(selectedProfileName);
  }
  const profileLayerCount = profileNames.size;
  const hasKnownProfileLayer = profileLayerCount > 0;
  const hasKnownProfileOrSelection = hasKnownProfileLayer || hasSelectedProfileId;
  const profileErrorNeedsAttention = hasProfileError && hasKnownProfileOrSelection;
  const repoBindingNeedsAttention = hasRepoBindingError && !repoBoundProfileName;
  const fallbackAttentionLayer: ConfigLayer = repoBindingNeedsAttention
    ? { label: 'Repo profile', detail: 'Open Settings to review' }
    : { label: 'Profile selection', detail: 'Open Settings to review' };

  if (profileErrorNeedsAttention || repoBindingNeedsAttention || selectedProfileNeedsAttention) {
    return {
      label: 'Config needs attention',
      layers: layers.length > 0 ? layers : [fallbackAttentionLayer],
      needsAttention: true,
    };
  }

  if (layers.length === 0) {
    return null;
  }

  if (isProfilesLoading && !hasManualConfig) {
    return null;
  }

  const label =
    profileLayerCount > 1
      ? 'Profiles active'
      : profileLayerCount === 1 && !hasManualConfig
        ? 'Profile active'
        : 'Custom config active';

  return {
    label,
    layers,
    needsAttention: false,
  };
}

type ProfileConfigIndicatorProps = {
  state: ProfileConfigIndicatorState | null;
  onOpenSettings: () => void;
  className?: string;
};

export function ProfileConfigIndicator({
  state,
  onOpenSettings,
  className,
}: ProfileConfigIndicatorProps) {
  if (!state) return null;

  const accessibleLayerText = state.layers
    .map(layer => (layer.detail ? `${layer.label}: ${layer.detail}` : layer.label))
    .join(', ');
  const accessibleLabel = `${state.label}. ${accessibleLayerText}. Open Settings to inspect or edit.`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={accessibleLabel}
          className={cn(
            'focus-visible:ring-ring inline-flex items-center gap-1.5 rounded-full border border-border/70 bg-muted/40 px-2.5 py-1 text-sm text-foreground transition-colors hover:bg-muted/60 focus-visible:ring-2 focus-visible:outline-none',
            state.needsAttention &&
              'border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/15 hover:text-amber-300',
            className
          )}
        >
          <SlidersHorizontal className="h-3.5 w-3.5" />
          <span>{state.label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" align="end" className="max-w-72 space-y-1 text-left">
        <p className="font-medium">{state.label}</p>
        {state.layers.map(layer => (
          <p key={`${layer.label}-${layer.detail ?? ''}`}>
            {layer.label}
            {layer.detail ? `: ${layer.detail}` : ''}
          </p>
        ))}
        <p className="opacity-80">Open Settings to inspect or edit.</p>
      </TooltipContent>
    </Tooltip>
  );
}
