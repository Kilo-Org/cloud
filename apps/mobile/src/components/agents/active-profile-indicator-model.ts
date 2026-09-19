/**
 * Pure state for the active-profile indicator. Ports the web
 * `buildProfileConfigIndicatorState` (`apps/web/src/components/cloud-agent/
 * ProfileConfigIndicator.tsx`) to the mobile copy keys, so the two surfaces
 * agree on when a profile is active, when manual config is layered on top, and
 * when the configuration needs attention.
 */

export const ACTIVE_PROFILE_INDICATOR_KEYS = {
  profileActive: 'agentChat.newSession.profileActive',
  profilesActive: 'agentChat.newSession.profilesActive',
  customConfigActive: 'agentChat.newSession.customConfigActive',
  configNeedsAttention: 'agentChat.newSession.configNeedsAttention',
  repoProfile: 'agentChat.newSession.repoProfile',
  selectedProfile: 'agentChat.newSession.selectedProfile',
  manualOverrides: 'agentChat.newSession.manualOverrides',
  manualEnvVars: 'profiles.variablesTitle',
  manualSetupCommands: 'profiles.commandsTitle',
  openSettingsToReview: 'agentChat.newSession.openSettingsToReview',
  profileSelection: 'agentChat.newSession.profileSelection',
} as const;

type ActiveProfileIndicatorKind =
  | 'profile-active'
  | 'profiles-active'
  | 'custom-config-active'
  | 'config-needs-attention';

export type ActiveProfileIndicatorLayer = {
  /** i18n key for the layer's label. */
  labelKey: string;
  /** A raw detail value (a profile name), when the layer has one. */
  detail?: string;
  /** i18n keys whose translated labels form the detail (manual overrides). */
  detailKeys?: string[];
};

export type ActiveProfileIndicatorState = {
  kind: ActiveProfileIndicatorKind;
  labelKey: string;
  layers: ActiveProfileIndicatorLayer[];
  needsAttention: boolean;
};

export type BuildActiveProfileIndicatorStateInput = {
  selectedProfileName?: string | null;
  repoBoundProfileName?: string | null;
  hasManualEnvVars: boolean;
  hasManualSetupCommands: boolean;
  hasSelectedProfileId: boolean;
  isProfilesLoading?: boolean;
  hasProfileError?: boolean;
  hasRepoBindingError?: boolean;
};

const K = ACTIVE_PROFILE_INDICATOR_KEYS;

export function buildActiveProfileIndicatorState({
  selectedProfileName,
  repoBoundProfileName,
  hasManualEnvVars,
  hasManualSetupCommands,
  hasSelectedProfileId,
  isProfilesLoading = false,
  hasProfileError = false,
  hasRepoBindingError = false,
}: BuildActiveProfileIndicatorStateInput): ActiveProfileIndicatorState | null {
  const hasManualConfig = hasManualEnvVars || hasManualSetupCommands;
  const layers: ActiveProfileIndicatorLayer[] = [];

  if (repoBoundProfileName) {
    layers.push({ labelKey: K.repoProfile, detail: repoBoundProfileName });
  }
  if (selectedProfileName) {
    layers.push({ labelKey: K.selectedProfile, detail: selectedProfileName });
  }
  if (hasManualConfig) {
    const detailKeys: string[] = [];
    if (hasManualEnvVars) {
      detailKeys.push(K.manualEnvVars);
    }
    if (hasManualSetupCommands) {
      detailKeys.push(K.manualSetupCommands);
    }
    layers.push({ labelKey: K.manualOverrides, detailKeys });
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
  const hasKnownProfileOrSelection = profileLayerCount > 0 || hasSelectedProfileId;
  const profileErrorNeedsAttention = hasProfileError && hasKnownProfileOrSelection;
  const repoBindingNeedsAttention = hasRepoBindingError && !repoBoundProfileName;
  const fallbackAttentionLayer: ActiveProfileIndicatorLayer = repoBindingNeedsAttention
    ? { labelKey: K.repoProfile, detailKeys: [K.openSettingsToReview] }
    : { labelKey: K.profileSelection, detailKeys: [K.openSettingsToReview] };

  if (profileErrorNeedsAttention || repoBindingNeedsAttention || selectedProfileNeedsAttention) {
    return {
      kind: 'config-needs-attention',
      labelKey: K.configNeedsAttention,
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

  if (profileLayerCount > 1) {
    return { kind: 'profiles-active', labelKey: K.profilesActive, layers, needsAttention: false };
  }
  if (profileLayerCount === 1 && !hasManualConfig) {
    return { kind: 'profile-active', labelKey: K.profileActive, layers, needsAttention: false };
  }
  return {
    kind: 'custom-config-active',
    labelKey: K.customConfigActive,
    layers,
    needsAttention: false,
  };
}
