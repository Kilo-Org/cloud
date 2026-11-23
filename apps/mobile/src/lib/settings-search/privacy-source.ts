import { defineSetting, type SettingsSearchSource } from '@/lib/settings-search/definitions';

/**
 * The optional analytics and install-source switch. Its row is the only
 * controllable setting on the consent surface; the required disclosures are
 * read-only.
 */
export const CONSENT_HELP_IMPROVE_SETTING = defineSetting(
  'consent.helpImprove',
  'consent.helpImprove',
  'privacy'
);

/** The consent review surface as one searchable group. */
export const PRIVACY_SETTINGS_SOURCE: SettingsSearchSource = {
  context: ['profile.privacyChoices'],
  path: '/(app)/consent',
  params: { mode: 'review' },
  settings: [CONSENT_HELP_IMPROVE_SETTING],
};
