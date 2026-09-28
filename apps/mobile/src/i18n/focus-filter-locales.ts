import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages.ts';

/**
 * The strings the iOS Focus filter declares as literals in
 * `modules/notification-focus-filter/ios/AgentProgressFocusFilter.swift`.
 *
 * `LocalizedStringResource`, `IntentDescription`, and `@Parameter(title:)`
 * resolve a string literal against the app bundle's `Localizable.strings` (the
 * default table), so the literal is the lookup key: an English literal here and
 * an entry with the same key in that catalog is all iOS needs. A test reads the
 * Swift source and fails when a literal here drifts from it.
 */
export const FOCUS_FILTER_STRINGS = {
  title: 'Agent notifications',
  description: 'Keep notifications that need your input and silence agent progress for this Focus.',
  agentProgress: 'Agent progress',
} as const;

type FocusFilterStringName = keyof typeof FOCUS_FILTER_STRINGS;

/** Prebuild-time copy, one entry per language tag. */
export type FocusFilterCopy = Record<string, Partial<Record<FocusFilterStringName, string>>>;

/** One language's `Localizable.strings` entries: English literal → translation. */
type FocusFilterStrings = Record<string, string>;

/** One language's rendered `Localizable.strings` content, keyed by language tag. */
export type FocusFilterStringsFiles = Record<SupportedLanguage, string>;

function readString(
  copy: Partial<Record<FocusFilterStringName, string>>,
  tag: string,
  name: FocusFilterStringName
): string {
  const value = copy[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(`Missing or empty Focus-filter copy for ${tag}.${name}`);
  }
  return value;
}

/**
 * The entries for every supported language, keyed by English literal. Throws
 * when a supported language or any of the three strings is missing or empty, so
 * a prebuild fails loudly instead of shipping an English Focus filter on a
 * localized device.
 */
function stringsByLanguage(copy: FocusFilterCopy): Record<SupportedLanguage, FocusFilterStrings> {
  const entries: [SupportedLanguage, FocusFilterStrings][] = [];
  for (const tag of SUPPORTED_LANGUAGES) {
    const entry = copy[tag];
    if (!entry) {
      throw new Error(`Missing Focus-filter copy for language: ${tag}`);
    }
    const strings: FocusFilterStrings = {};
    for (const name of Object.keys(FOCUS_FILTER_STRINGS) as FocusFilterStringName[]) {
      strings[FOCUS_FILTER_STRINGS[name]] = readString(entry, tag, name);
    }
    entries.push([tag, strings]);
  }
  return Object.fromEntries(entries) as Record<SupportedLanguage, FocusFilterStrings>;
}

/** Only the quote and the backslash need escaping in a `.strings` entry. */
const escapeStringsEntry = (text: string) => text.replaceAll(/[\\"]/g, String.raw`\$&`);

function stringsLine(key: string, value: string): string {
  return `"${escapeStringsEntry(key)}" = "${escapeStringsEntry(value)}";`;
}

/**
 * Renders one language's `Localizable.strings`. Every key is quoted and escaped
 * because the Swift literals carry spaces: a bare key (`Agent notifications = "…";`)
 * is not a parseable entry, and the Xcode CopyStringsFile step rejects the whole
 * file, so no Focus-filter string resolves and the control stays English on a
 * localized device. `withAppIntentLocalizations` appends this to the app
 * target's single catalog.
 */
function renderFocusFilterStrings(strings: FocusFilterStrings): string {
  const lines = Object.entries(strings).map(([key, value]) => stringsLine(key, value));
  return `${lines.join('\n')}\n`;
}

/**
 * The rendered `Localizable.strings` body for every supported language, keyed by
 * tag. `app.config.ts` hands this to `withAppIntentLocalizations`, which appends
 * it to the app target's one catalog file so the Focus filter's literals resolve
 * from the app bundle.
 */
export function buildFocusFilterStringsFiles(copy: FocusFilterCopy): FocusFilterStringsFiles {
  const strings = stringsByLanguage(copy);
  const files: [SupportedLanguage, string][] = SUPPORTED_LANGUAGES.map(tag => [
    tag,
    renderFocusFilterStrings(strings[tag]),
  ]);
  return Object.fromEntries(files) as FocusFilterStringsFiles;
}
