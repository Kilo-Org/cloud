import { type Href } from 'expo-router';
import { type ParseKeys } from 'i18next';

/**
 * The one concept a setting can also be found by, beyond its visible label.
 * Each keyword resolves to a catalog entry under
 * `settingsSearch.keywords.<keyword>` whose value is the list of localized
 * synonyms for that concept, one term per entry.
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
  label: ParseKeys;
  keyword?: SettingsKeyword;
  available?: boolean;
};

/**
 * The pathname of a typed route whose params are optional, as a destination
 * screen's search target uses it. A route that requires params is left out:
 * its Href variant cannot be built from a pathname alone, and every indexed
 * destination is reachable without them.
 */
export type SettingsPath = Exclude<
  Extract<Href, { pathname: string }>,
  { params: object }
>['pathname'];

/**
 * One group of settings sharing a screen. `context` names the containing
 * screen in the reader's language (a breadcrumb on every result); `path` is the
 * screen route a result opens, and its absence marks a row on the root screen
 * that a result reveals in place. `params` rides with the route when the
 * destination needs them (the consent review surface).
 */
export type SettingsSearchSource = {
  context?: readonly ParseKeys[];
  path?: SettingsPath;
  params?: Readonly<Record<string, string>>;
  settings: readonly SettingDefinition[];
};

/** The route parameter a destination screen forwards to `SettingsSearchScrollView`. */
export type SettingsTargetProps = { settingsTarget?: string };

/** Declare one searchable setting without spelling the definition's shape. */
export function defineSetting(
  id: string,
  label: ParseKeys,
  keyword?: SettingsKeyword
): SettingDefinition {
  return { id, label, keyword };
}
