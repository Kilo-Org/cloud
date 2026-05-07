import type { MorningBriefingStatusLite } from '@/lib/kiloclaw/types';

export type MorningBriefingCardStateInput = {
  isRunning: boolean;
  actionsReady: boolean;
  briefingStatus: MorningBriefingStatusLite | undefined;
};

export type MorningBriefingCardState = {
  desiredEnabled: boolean;
  observedEnabled: boolean;
  hasResolvedBriefingToggleState: boolean;
  isGatewayWarmupStatus: boolean;
  isWarmupState: boolean;
  isControllerOutOfDate: boolean;
};

export function deriveMorningBriefingCardState(
  input: MorningBriefingCardStateInput
): MorningBriefingCardState {
  const desiredEnabledValue = input.briefingStatus?.desiredEnabled ?? input.briefingStatus?.enabled;
  const observedEnabledValue =
    input.briefingStatus?.observedEnabled ?? input.briefingStatus?.enabled;
  const isGatewayWarmupStatus = input.briefingStatus?.code === 'gateway_warming_up';
  const isControllerOutOfDate = input.briefingStatus?.code === 'controller_route_unavailable';
  const hasResolvedBriefingToggleState =
    typeof desiredEnabledValue === 'boolean' && typeof observedEnabledValue === 'boolean';
  const desiredEnabled = desiredEnabledValue ?? false;
  const observedEnabled = observedEnabledValue ?? false;
  // Out-of-date controller takes precedence over warmup: the user needs to act
  // (upgrade), not wait. Suppress warmup so the two banners don't fight.
  const isWarmupState =
    !isControllerOutOfDate &&
    input.isRunning &&
    (input.actionsReady === false || isGatewayWarmupStatus || !hasResolvedBriefingToggleState);

  return {
    desiredEnabled,
    observedEnabled,
    hasResolvedBriefingToggleState,
    isGatewayWarmupStatus,
    isWarmupState,
    isControllerOutOfDate,
  };
}
