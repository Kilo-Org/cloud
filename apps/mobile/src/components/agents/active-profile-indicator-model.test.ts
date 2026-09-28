import { describe, expect, it } from 'vitest';

import {
  buildActiveProfileIndicatorState,
  ACTIVE_PROFILE_INDICATOR_KEYS as K,
} from './active-profile-indicator-model';

const noManual = { hasManualEnvVars: false, hasManualSetupCommands: false };

describe('buildActiveProfileIndicatorState', () => {
  it('shows a single selected profile as Profile active', () => {
    const state = buildActiveProfileIndicatorState({
      selectedProfileName: 'Backend',
      repoBoundProfileName: null,
      hasSelectedProfileId: true,
      ...noManual,
    });

    expect(state).toEqual({
      kind: 'profile-active',
      labelKey: K.profileActive,
      layers: [{ labelKey: K.selectedProfile, detail: 'Backend' }],
      needsAttention: false,
    });
  });

  it('shows a repo profile and a selected profile as Profiles active', () => {
    const state = buildActiveProfileIndicatorState({
      selectedProfileName: 'Backend',
      repoBoundProfileName: 'Repo profile',
      hasSelectedProfileId: true,
      ...noManual,
    });

    expect(state?.kind).toBe('profiles-active');
    expect(state?.labelKey).toBe(K.profilesActive);
    expect(state?.layers.map(layer => layer.labelKey)).toEqual([K.repoProfile, K.selectedProfile]);
    expect(state?.needsAttention).toBe(false);
  });

  it('shows manual config on top of a profile as Custom config active', () => {
    const state = buildActiveProfileIndicatorState({
      selectedProfileName: 'Backend',
      repoBoundProfileName: null,
      hasSelectedProfileId: true,
      hasManualEnvVars: true,
      hasManualSetupCommands: true,
    });

    expect(state?.kind).toBe('custom-config-active');
    expect(state?.labelKey).toBe(K.customConfigActive);
    expect(state?.layers).toEqual([
      { labelKey: K.selectedProfile, detail: 'Backend' },
      { labelKey: K.manualOverrides, detailKeys: [K.manualEnvVars, K.manualSetupCommands] },
    ]);
  });

  it('shows custom config with only manual overrides, no profile', () => {
    const state = buildActiveProfileIndicatorState({
      selectedProfileName: null,
      repoBoundProfileName: null,
      hasSelectedProfileId: false,
      hasManualEnvVars: true,
      hasManualSetupCommands: false,
    });

    expect(state?.kind).toBe('custom-config-active');
    expect(state?.labelKey).toBe(K.customConfigActive);
    expect(state?.layers).toEqual([{ labelKey: K.manualOverrides, detailKeys: [K.manualEnvVars] }]);
  });

  it('needs attention when the selected id resolves to no profile', () => {
    const state = buildActiveProfileIndicatorState({
      selectedProfileName: null,
      repoBoundProfileName: null,
      hasSelectedProfileId: true,
      ...noManual,
    });

    expect(state?.kind).toBe('config-needs-attention');
    expect(state?.labelKey).toBe(K.configNeedsAttention);
    expect(state?.needsAttention).toBe(true);
    expect(state?.layers).toEqual([
      { labelKey: K.profileSelection, detailKeys: [K.openSettingsToReview] },
    ]);
  });

  it('does not flag attention while the profiles query is still loading', () => {
    const state = buildActiveProfileIndicatorState({
      selectedProfileName: null,
      repoBoundProfileName: null,
      hasSelectedProfileId: true,
      ...noManual,
      isProfilesLoading: true,
    });

    expect(state).toBeNull();
  });

  it('needs attention on a profile error only when a profile layer is known', () => {
    const withLayer = buildActiveProfileIndicatorState({
      selectedProfileName: 'Backend',
      repoBoundProfileName: null,
      hasSelectedProfileId: true,
      ...noManual,
      hasProfileError: true,
    });
    expect(withLayer?.needsAttention).toBe(true);
    expect(withLayer?.labelKey).toBe(K.configNeedsAttention);
    expect(withLayer?.layers).toEqual([{ labelKey: K.selectedProfile, detail: 'Backend' }]);

    const withoutLayer = buildActiveProfileIndicatorState({
      selectedProfileName: null,
      repoBoundProfileName: null,
      hasSelectedProfileId: false,
      ...noManual,
      hasProfileError: true,
    });
    expect(withoutLayer).toBeNull();
  });

  it('needs attention on a repo-binding error that leaves no repo profile', () => {
    const state = buildActiveProfileIndicatorState({
      selectedProfileName: null,
      repoBoundProfileName: null,
      hasSelectedProfileId: false,
      ...noManual,
      hasRepoBindingError: true,
    });

    expect(state?.needsAttention).toBe(true);
    expect(state?.layers).toEqual([
      { labelKey: K.repoProfile, detailKeys: [K.openSettingsToReview] },
    ]);
  });

  it('renders nothing when there is no profile and no manual config', () => {
    expect(
      buildActiveProfileIndicatorState({
        selectedProfileName: null,
        repoBoundProfileName: null,
        hasSelectedProfileId: false,
        ...noManual,
      })
    ).toBeNull();
  });

  it('renders nothing while profiles load and only a profile layer would show', () => {
    expect(
      buildActiveProfileIndicatorState({
        selectedProfileName: null,
        repoBoundProfileName: null,
        hasSelectedProfileId: false,
        ...noManual,
        isProfilesLoading: true,
      })
    ).toBeNull();
  });
});
