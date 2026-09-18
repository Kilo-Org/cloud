// Copy for the iOS App Intents, one entry per language tag.
//
// This is bundle metadata, not app copy. An App Intent's `title`, its parameter
// names and its `AppShortcutsProvider` phrases bind to `LocalizedStringResource`,
// which SwiftUI and App Intents resolve against `Localizable.strings` in the
// bundle the code was compiled into — the main app target here. So the English
// string is the key (the Swift sources carry exactly those literals) and this
// file is the one place a translation is added. It never goes through i18next,
// which is why it lives beside `withAppIntentLocalizations.js` rather than in
// `src/i18n/locales`.
//
// Pure helpers: nothing here reads a file or touches the Xcode project, so the
// contract test exercises them without a prebuild or a pbxproj.

/** The keys every language's entry holds. The English value is the `.strings` key. */
const INTENT_COPY_KEYS = [
  'startAgent',
  'openNeedsInput',
  'openSession',
  'openPullRequest',
  'promptParam',
  'repositoryParam',
  'sessionParam',
  'pullRequestParam',
  'startFailedFallback',
];

/** One `.strings` entry. Only the quote and the backslash need escaping. */
const stringsLine = (key, value) =>
  `"${key.replace(/[\\"]/g, '\\$&')}" = "${value.replace(/[\\"]/g, '\\$&')}";`;

/**
 * The keys `tag`'s entry is missing, or an entry of its own when the tag has no
 * copy at all. An empty value counts as missing: it would render as
 * `"Start agent" = "";` and erase the label.
 *
 * @param {Record<string, Record<string, string>> | undefined} copy
 * @param {string} tag
 * @returns {string[]}
 */
function missingIntentCopyKeys(copy, tag) {
  const entry = copy?.[tag];
  if (entry === undefined) {
    return [...INTENT_COPY_KEYS];
  }
  return INTENT_COPY_KEYS.filter(key => {
    const value = entry[key];
    return typeof value !== 'string' || value.trim().length === 0;
  });
}

/**
 * Throws unless `tag`'s entry holds every key. The plugin calls this per
 * language, so a prebuild fails loudly instead of shipping an English label on
 * a localized device — the contract `withWidgetLocalizations` already keeps.
 *
 * @param {Record<string, Record<string, string>> | undefined} copy
 * @param {string} tag
 */
function assertIntentCopy(copy, tag) {
  const missing = missingIntentCopyKeys(copy, tag);
  if (missing.length > 0) {
    throw new Error(`app-intent-copy: ${tag} is missing ${missing.join(', ')}`);
  }
}

/**
 * The `Localizable.strings` body for one language: one escaped line per key,
 * keyed by the English copy.
 *
 * @param {Record<string, Record<string, string>> | undefined} copy
 * @param {string} tag
 * @returns {string}
 */
function renderLocalizableStrings(copy, tag) {
  const english = copy?.en;
  if (english === undefined) {
    throw new Error('app-intent-copy: the copy needs an `en` entry');
  }
  assertIntentCopy(copy, tag);
  const entry = copy[tag];
  const lines = INTENT_COPY_KEYS.map(key => stringsLine(english[key], entry[key]));
  return `${lines.join('\n')}\n`;
}

module.exports = {
  INTENT_COPY_KEYS,
  assertIntentCopy,
  missingIntentCopyKeys,
  renderLocalizableStrings,
};
