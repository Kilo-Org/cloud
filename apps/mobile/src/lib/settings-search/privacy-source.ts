import { type Href } from 'expo-router';

import {
  defineSetting,
  type SettingDefinition,
  type SettingsSearchSource,
} from '@/lib/settings-search/definitions';

/**
 * The review surface a re-opened disclosure presents. The data-sharing choices
 * live only there: onboarding is not a destination a search result may open, so
 * the route is always entered in `review` mode.
 */
const CONSENT_REVIEW_PATH = '/(app)/consent' as Extract<Href, string>;

/** The Profile row that opens the privacy choices screen. */
const PRIVACY_CONTEXT = 'profile.privacyChoices';

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
  context: [PRIVACY_CONTEXT],
  path: CONSENT_REVIEW_PATH,
  params: { mode: 'review' },
  settings: [CONSENT_HELP_IMPROVE_SETTING],
};
