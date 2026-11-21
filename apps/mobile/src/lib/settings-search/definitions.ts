import { type Href } from 'expo-router';
import { type ParseKeys } from 'i18next';

/**
 * The one concept a setting can also be found by, beyond its visible label.
 * Each keyword resolves to a catalog entry under
 * `settingsSearch.keywords.<keyword>` whose value holds the localized synonyms
 * separated by `|`.
 */
export type SettingsKeyword =
  | 'signOut'
  | 'appearance'
  | 'appUnlock'
  | 'language'
  | 'notifications'
  | 'privacy';

/**
 * One searchable setting: the row's stable id (also the route `settingsTarget`
 * a result opens), its English catalog label, and the concept keyword and
 * availability the search index needs.
 */
export type SettingDefinition = {
  id: string;
  label: ParseKeys<'translation'>;
  keyword?: SettingsKeyword;
  available?: boolean;
};

/** The pathname form of a typed route, as a destination screen's search target uses it. */
export type SettingsPath = Extract<Href, { pathname: string }>['pathname'];

/**
 * One group of settings sharing a screen. `context` names the containing
 * screen in the reader's language (a breadcrumb on every result); `path` is the
 * screen route a result opens, and its absence marks a row on the root screen
 * that a result reveals in place. `params` rides with the route when the
 * destination needs them (the consent review surface).
 */
export type SettingsSearchSource = {
  context?: readonly ParseKeys<'translation'>[];
  path?: SettingsPath;
  params?: Readonly<Record<string, string>>;
  settings: readonly SettingDefinition[];
};

/** The route parameter a destination screen forwards to `SettingsSearchScrollView`. */
export type SettingsTargetProps = { settingsTarget?: string };

/** Declare one searchable setting without spelling the definition's shape. */
export function defineSetting(
  id: string,
  label: ParseKeys<'translation'>,
  keyword?: SettingsKeyword
): SettingDefinition {
  return { id, label, keyword };
}
