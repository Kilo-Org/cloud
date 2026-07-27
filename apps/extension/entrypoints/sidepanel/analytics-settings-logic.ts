export const ANALYTICS_SETTINGS_SAVE_ERROR = "Couldn't save the setting. Try again.";

export const FIREFOX_USAGE_DATA_BLOCKED_HINT = 'Firefox is blocking usage data collection.';

export type AnalyticsSettingsPhase = 'loading' | 'settled' | 'saving' | 'error';

export interface AnalyticsSettingsState {
  readonly checked: boolean;
  readonly errorMessage: string | null;
  readonly firefoxUsageDataGranted: boolean;
  readonly phase: AnalyticsSettingsPhase;
  readonly priorChecked: boolean | null;
}

export interface AnalyticsSettingsLoadResult {
  readonly firefoxUsageDataGranted: boolean;
  readonly optedOut: boolean;
}

export interface AnalyticsSettingsFlipStart {
  readonly nextChecked: boolean;
  readonly optedOut: boolean;
  readonly priorChecked: boolean;
  readonly state: AnalyticsSettingsState;
}

/** Default while the flag is unread: enabled (opt-out absent). */
export const createInitialAnalyticsSettingsState = (): AnalyticsSettingsState => ({
  checked: true,
  errorMessage: null,
  firefoxUsageDataGranted: true,
  phase: 'loading',
  priorChecked: null,
});

export const applyAnalyticsSettingsLoaded = (
  input: AnalyticsSettingsLoadResult
): AnalyticsSettingsState => ({
  checked: !input.optedOut,
  errorMessage: null,
  firefoxUsageDataGranted: input.firefoxUsageDataGranted,
  phase: 'settled',
  priorChecked: null,
});

export const isAnalyticsSettingsInteractive = (state: AnalyticsSettingsState): boolean =>
  state.phase === 'settled' || state.phase === 'error';

export const shouldShowFirefoxUsageDataHint = (firefoxUsageDataGranted: boolean): boolean =>
  !firefoxUsageDataGranted;

/**
 * Every storage-write rejection is retryable. The CTA is flipping the toggle again.
 * Non-retryable failures are structurally impossible for this control.
 */
export const mapAnalyticsSettingsSaveRejection = (
  _error: unknown
): typeof ANALYTICS_SETTINGS_SAVE_ERROR => ANALYTICS_SETTINGS_SAVE_ERROR;

export const beginAnalyticsSettingsFlip = (
  state: AnalyticsSettingsState
): AnalyticsSettingsFlipStart | null => {
  if (!isAnalyticsSettingsInteractive(state)) {
    return null;
  }

  const priorChecked = state.checked;
  const nextChecked = !priorChecked;
  return {
    nextChecked,
    optedOut: !nextChecked,
    priorChecked,
    state: {
      checked: nextChecked,
      errorMessage: null,
      firefoxUsageDataGranted: state.firefoxUsageDataGranted,
      phase: 'saving',
      priorChecked,
    },
  };
};

export const completeAnalyticsSettingsFlip = (
  state: AnalyticsSettingsState
): AnalyticsSettingsState => ({
  checked: state.checked,
  errorMessage: null,
  firefoxUsageDataGranted: state.firefoxUsageDataGranted,
  phase: 'settled',
  priorChecked: null,
});

export const failAnalyticsSettingsFlip = (
  state: AnalyticsSettingsState,
  priorChecked: boolean
): AnalyticsSettingsState => ({
  checked: priorChecked,
  errorMessage: ANALYTICS_SETTINGS_SAVE_ERROR,
  firefoxUsageDataGranted: state.firefoxUsageDataGranted,
  phase: 'error',
  priorChecked: null,
});

/** Identity payload for `setAnalyticsOptOut` when re-enabling analytics. */
export const resolveAnalyticsOptOutIdentity = (
  optedOut: boolean,
  email?: string
): { readonly email: string } | undefined => {
  if (optedOut) {
    return undefined;
  }

  if (email === undefined || email.trim().length === 0) {
    return undefined;
  }

  return { email };
};
