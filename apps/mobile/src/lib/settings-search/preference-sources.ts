import { defineSetting, type SettingsSearchSource } from '@/lib/settings-search/definitions';

/**
 * Settings search index for the Preferences surfaces.
 *
 * Each screen renders the same named definition object its source publishes
 * through `Object.values`, so a row cannot be added (or removed) in the UI
 * without the index following, and the index cannot name a row the screen does
 * not render.
 */

/** Every row on the Preferences hub. `appearance` labels its section. */
const PREFERENCES_HUB_SETTINGS = {
  general: defineSetting('general', 'preferences.general'),
  voiceInput: defineSetting('voice-input', 'preferences.voiceInput'),
  toolSummaryTranslation: defineSetting(
    'tool-summary-translation',
    'preferences.toolSummaryTranslation',
    'language'
  ),
  appearance: defineSetting('appearance', 'preferences.appearance', 'appearance'),
  appearanceSystem: defineSetting(
    'appearance.system',
    'preferences.appearanceSystem',
    'appearance'
  ),
  appearanceLight: defineSetting(
    'appearance.light',
    'preferences.appearanceLight',
    'appearance'
  ),
  appearanceDark: defineSetting(
    'appearance.dark',
    'preferences.appearanceDark',
    'appearance'
  ),
  account: defineSetting('account', 'preferences.account', 'language'),
  notifications: defineSetting('notifications', 'common.notifications', 'notifications'),
  notificationHistory: defineSetting(
    'notification-history',
    'notifications.history.title',
    'notifications'
  ),
  spendAlerts: defineSetting(
    'spend-alerts',
    'notifications.channel.spend',
    'notifications'
  ),
} as const;

const GENERAL_SETTINGS = {
  appUnlock: defineSetting('general.app-unlock', 'preferences.biometricUnlock', 'appUnlock'),
  autoExpandThinking: defineSetting(
    'general.auto-expand-thinking',
    'preferences.autoExpandThinking'
  ),
  hideThinking: defineSetting('general.hide-thinking', 'preferences.hideThinking'),
  condenseToolCalls: defineSetting(
    'general.condense-tool-calls',
    'preferences.condenseToolCalls'
  ),
  keepScreenOn: defineSetting('general.keep-screen-on', 'preferences.keepScreenOn'),
  prReviewAttribution: defineSetting(
    'general.pr-review-attribution',
    'preferences.prReviewAttribution'
  ),
  returnSendsMessage: defineSetting(
    'general.return-sends-message',
    'preferences.returnSendsMessage'
  ),
} as const;

const VOICE_INPUT_SETTINGS = {
  gatewayTranscription: defineSetting(
    'voice-input.gateway-transcription',
    'preferences.gatewayTranscription'
  ),
  transcriptionModel: defineSetting(
    'voice-input.model',
    'preferences.transcriptionModel'
  ),
  language: defineSetting('voice-input.language', 'common.language', 'language'),
} as const;

const TOOL_SUMMARY_TRANSLATION_SETTINGS = {
  translateSummaries: defineSetting(
    'tool-summary-translation.enabled',
    'preferences.translateSummaries',
    'language'
  ),
  model: defineSetting('tool-summary-translation.model', 'common.model', 'language'),
} as const;

const ACCOUNT_SETTINGS = {
  profile: defineSetting('account.profile', 'profile.editProfile.title'),
  signInMethods: defineSetting('account.sign-in-methods', 'profile.signInMethods.title'),
  language: defineSetting('account.language', 'common.language', 'language'),
  trustedHosts: defineSetting('account.trusted-hosts', 'trustedHosts.title', 'privacy'),
  passkeys: defineSetting('account.passkeys', 'profile.passkeysTitle', 'privacy'),
  providerKeys: defineSetting('account.provider-keys', 'profile.providerKeys.title'),
  dataExport: defineSetting('account.data-export', 'profile.dataExport.title', 'privacy'),
  blockedPeople: defineSetting(
    'account.blocked-people',
    'profile.blockedPeople.title',
    'privacy'
  ),
  reportReceipts: defineSetting(
    'account.report-receipts',
    'profile.reportReceipts.title',
    'privacy'
  ),
  deviceSessions: defineSetting(
    'account.device-sessions',
    'common.deviceSessions',
    'privacy'
  ),
  browserSignOut: defineSetting(
    'account.browser-sign-out',
    'profile.signOutWeb.title',
    'signOut'
  ),
} as const;

const PREFERENCES_HUB_SOURCE: SettingsSearchSource = {
  context: ['common.preferences'],
  path: '/(app)/(tabs)/(3_profile)/preferences',
  settings: Object.values(PREFERENCES_HUB_SETTINGS),
};

const GENERAL_SOURCE: SettingsSearchSource = {
  context: ['common.preferences', 'preferences.general'],
  path: '/(app)/(tabs)/(3_profile)/general',
  settings: Object.values(GENERAL_SETTINGS),
};

const VOICE_INPUT_SOURCE: SettingsSearchSource = {
  context: ['common.preferences', 'preferences.voiceInput'],
  path: '/(app)/(tabs)/(3_profile)/voice-input',
  settings: Object.values(VOICE_INPUT_SETTINGS),
};

const TOOL_SUMMARY_TRANSLATION_SOURCE: SettingsSearchSource = {
  context: ['common.preferences', 'preferences.toolSummaryTranslation'],
  path: '/(app)/(tabs)/(3_profile)/tool-summary-translation',
  settings: Object.values(TOOL_SUMMARY_TRANSLATION_SETTINGS),
};

const ACCOUNT_SOURCE: SettingsSearchSource = {
  context: ['common.preferences', 'preferences.account'],
  path: '/(app)/(tabs)/(3_profile)/account',
  settings: Object.values(ACCOUNT_SETTINGS),
};

export const PREFERENCE_SETTINGS_SOURCES: readonly SettingsSearchSource[] = [
  PREFERENCES_HUB_SOURCE,
  GENERAL_SOURCE,
  VOICE_INPUT_SOURCE,
  TOOL_SUMMARY_TRANSLATION_SOURCE,
  ACCOUNT_SOURCE,
];

export {
  ACCOUNT_SETTINGS,
  GENERAL_SETTINGS,
  PREFERENCES_HUB_SETTINGS,
  TOOL_SUMMARY_TRANSLATION_SETTINGS,
  VOICE_INPUT_SETTINGS,
};
