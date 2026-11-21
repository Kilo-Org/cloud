import { defineSetting, type SettingsSearchSource } from '@/lib/settings-search/definitions';

/**
 * Settings search index for the Preferences surfaces. Every definition here is
 * the one the screen also renders from, so the indexed label can never drift
 * from the visible row (a row added without a definition, or a definition
 * without a row, fails the mounted coverage tests).
 *
 * Order follows the current screens and their menu order.
 */

// Preferences hub.
const GENERAL_SETTING = defineSetting('general', 'preferences.general');
const VOICE_INPUT_SETTING = defineSetting('voice-input', 'preferences.voiceInput');
const TOOL_SUMMARY_TRANSLATION_SETTING = defineSetting(
  'tool-summary-translation',
  'preferences.toolSummaryTranslation',
  'language'
);
const APPEARANCE_SETTING = defineSetting('appearance', 'preferences.appearance', 'appearance');
const APPEARANCE_SYSTEM_SETTING = defineSetting(
  'appearance.system',
  'preferences.appearanceSystem',
  'appearance'
);
const APPEARANCE_LIGHT_SETTING = defineSetting(
  'appearance.light',
  'preferences.appearanceLight',
  'appearance'
);
const APPEARANCE_DARK_SETTING = defineSetting(
  'appearance.dark',
  'preferences.appearanceDark',
  'appearance'
);
const ACCOUNT_SETTING = defineSetting('account', 'preferences.account', 'language');
const NOTIFICATIONS_SETTING = defineSetting(
  'notifications',
  'common.notifications',
  'notifications'
);
const NOTIFICATION_HISTORY_SETTING = defineSetting(
  'notification-history',
  'notifications.history.title',
  'notifications'
);
const SPEND_ALERTS_SETTING = defineSetting(
  'spend-alerts',
  'notifications.channel.spend',
  'notifications'
);

// General.
const APP_UNLOCK_SETTING = defineSetting(
  'general.app-unlock',
  'preferences.biometricUnlock',
  'appUnlock'
);
const AUTO_EXPAND_THINKING_SETTING = defineSetting(
  'general.auto-expand-thinking',
  'preferences.autoExpandThinking'
);
const HIDE_THINKING_SETTING = defineSetting('general.hide-thinking', 'preferences.hideThinking');
const CONDENSE_TOOL_CALLS_SETTING = defineSetting(
  'general.condense-tool-calls',
  'preferences.condenseToolCalls'
);
const KEEP_SCREEN_ON_SETTING = defineSetting(
  'general.keep-screen-on',
  'preferences.keepScreenOn'
);
const PR_REVIEW_ATTRIBUTION_SETTING = defineSetting(
  'general.pr-review-attribution',
  'preferences.prReviewAttribution'
);
const RETURN_SENDS_MESSAGE_SETTING = defineSetting(
  'general.return-sends-message',
  'preferences.returnSendsMessage'
);

// Voice input.
const GATEWAY_TRANSCRIPTION_SETTING = defineSetting(
  'voice-input.gateway-transcription',
  'preferences.gatewayTranscription'
);
const TRANSCRIPTION_MODEL_SETTING = defineSetting(
  'voice-input.model',
  'preferences.transcriptionModel'
);
const VOICE_LANGUAGE_SETTING = defineSetting('voice-input.language', 'common.language', 'language');

// Tool summary translation.
const TRANSLATE_SUMMARIES_SETTING = defineSetting(
  'tool-summary-translation.enabled',
  'preferences.translateSummaries',
  'language'
);
const TRANSLATION_MODEL_SETTING = defineSetting(
  'tool-summary-translation.model',
  'common.model',
  'language'
);

// Account.
const ACCOUNT_PROFILE_SETTING = defineSetting('account.profile', 'profile.editProfile.title');
const ACCOUNT_SIGN_IN_METHODS_SETTING = defineSetting(
  'account.sign-in-methods',
  'profile.signInMethods.title'
);
const ACCOUNT_LANGUAGE_SETTING = defineSetting('account.language', 'common.language', 'language');
const ACCOUNT_TRUSTED_HOSTS_SETTING = defineSetting(
  'account.trusted-hosts',
  'trustedHosts.title',
  'privacy'
);
const ACCOUNT_PASSKEYS_SETTING = defineSetting(
  'account.passkeys',
  'profile.passkeysTitle',
  'privacy'
);
const ACCOUNT_PROVIDER_KEYS_SETTING = defineSetting(
  'account.provider-keys',
  'profile.providerKeys.title'
);
const ACCOUNT_DATA_EXPORT_SETTING = defineSetting(
  'account.data-export',
  'profile.dataExport.title',
  'privacy'
);
const ACCOUNT_BLOCKED_PEOPLE_SETTING = defineSetting(
  'account.blocked-people',
  'profile.blockedPeople.title',
  'privacy'
);
const ACCOUNT_REPORT_RECEIPTS_SETTING = defineSetting(
  'account.report-receipts',
  'profile.reportReceipts.title',
  'privacy'
);
const ACCOUNT_DEVICE_SESSIONS_SETTING = defineSetting(
  'account.device-sessions',
  'common.deviceSessions',
  'privacy'
);

export {
  APPEARANCE_SETTING,
  APPEARANCE_SYSTEM_SETTING,
  APPEARANCE_LIGHT_SETTING,
  APPEARANCE_DARK_SETTING,
};
export {
  GENERAL_SETTING,
  VOICE_INPUT_SETTING,
  TOOL_SUMMARY_TRANSLATION_SETTING,
  ACCOUNT_SETTING,
  NOTIFICATIONS_SETTING,
  NOTIFICATION_HISTORY_SETTING,
  SPEND_ALERTS_SETTING,
};
export {
  APP_UNLOCK_SETTING,
  AUTO_EXPAND_THINKING_SETTING,
  HIDE_THINKING_SETTING,
  CONDENSE_TOOL_CALLS_SETTING,
  KEEP_SCREEN_ON_SETTING,
  PR_REVIEW_ATTRIBUTION_SETTING,
  RETURN_SENDS_MESSAGE_SETTING,
};
export {
  GATEWAY_TRANSCRIPTION_SETTING,
  TRANSCRIPTION_MODEL_SETTING,
  VOICE_LANGUAGE_SETTING,
};
export { TRANSLATE_SUMMARIES_SETTING, TRANSLATION_MODEL_SETTING };
export {
  ACCOUNT_PROFILE_SETTING,
  ACCOUNT_SIGN_IN_METHODS_SETTING,
  ACCOUNT_LANGUAGE_SETTING,
  ACCOUNT_TRUSTED_HOSTS_SETTING,
  ACCOUNT_PASSKEYS_SETTING,
  ACCOUNT_PROVIDER_KEYS_SETTING,
  ACCOUNT_DATA_EXPORT_SETTING,
  ACCOUNT_BLOCKED_PEOPLE_SETTING,
  ACCOUNT_REPORT_RECEIPTS_SETTING,
  ACCOUNT_DEVICE_SESSIONS_SETTING,
};

const PREFERENCES_HUB_SOURCE: SettingsSearchSource = {
  context: ['common.preferences'],
  path: '/(app)/(tabs)/(3_profile)/preferences',
  settings: [
    GENERAL_SETTING,
    VOICE_INPUT_SETTING,
    TOOL_SUMMARY_TRANSLATION_SETTING,
    APPEARANCE_SETTING,
    APPEARANCE_SYSTEM_SETTING,
    APPEARANCE_LIGHT_SETTING,
    APPEARANCE_DARK_SETTING,
    ACCOUNT_SETTING,
    NOTIFICATIONS_SETTING,
    NOTIFICATION_HISTORY_SETTING,
    SPEND_ALERTS_SETTING,
  ],
};

const GENERAL_SOURCE: SettingsSearchSource = {
  context: ['common.preferences', 'preferences.general'],
  path: '/(app)/(tabs)/(3_profile)/general',
  settings: [
    APP_UNLOCK_SETTING,
    AUTO_EXPAND_THINKING_SETTING,
    HIDE_THINKING_SETTING,
    CONDENSE_TOOL_CALLS_SETTING,
    KEEP_SCREEN_ON_SETTING,
    PR_REVIEW_ATTRIBUTION_SETTING,
    RETURN_SENDS_MESSAGE_SETTING,
  ],
};

const VOICE_INPUT_SOURCE: SettingsSearchSource = {
  context: ['common.preferences', 'preferences.voiceInput'],
  path: '/(app)/(tabs)/(3_profile)/voice-input',
  settings: [
    GATEWAY_TRANSCRIPTION_SETTING,
    TRANSCRIPTION_MODEL_SETTING,
    VOICE_LANGUAGE_SETTING,
  ],
};

const TOOL_SUMMARY_TRANSLATION_SOURCE: SettingsSearchSource = {
  context: ['common.preferences', 'preferences.toolSummaryTranslation'],
  path: '/(app)/(tabs)/(3_profile)/tool-summary-translation',
  settings: [TRANSLATE_SUMMARIES_SETTING, TRANSLATION_MODEL_SETTING],
};

const ACCOUNT_SOURCE: SettingsSearchSource = {
  context: ['common.preferences', 'preferences.account'],
  path: '/(app)/(tabs)/(3_profile)/account',
  settings: [
    ACCOUNT_PROFILE_SETTING,
    ACCOUNT_SIGN_IN_METHODS_SETTING,
    ACCOUNT_LANGUAGE_SETTING,
    ACCOUNT_TRUSTED_HOSTS_SETTING,
    ACCOUNT_PASSKEYS_SETTING,
    ACCOUNT_PROVIDER_KEYS_SETTING,
    ACCOUNT_DATA_EXPORT_SETTING,
    ACCOUNT_BLOCKED_PEOPLE_SETTING,
    ACCOUNT_REPORT_RECEIPTS_SETTING,
    ACCOUNT_DEVICE_SESSIONS_SETTING,
  ],
};

export const PREFERENCE_SETTINGS_SOURCES: readonly SettingsSearchSource[] = [
  PREFERENCES_HUB_SOURCE,
  GENERAL_SOURCE,
  VOICE_INPUT_SOURCE,
  TOOL_SUMMARY_TRANSLATION_SOURCE,
  ACCOUNT_SOURCE,
];
