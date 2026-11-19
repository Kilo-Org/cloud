import { type Href } from 'expo-router';

import { type LanguageReturnTarget } from '@/i18n/return-target';

/** The Profile tab's root screen, as a route path. */
const PROFILE_TAB_ROOT = '/(app)/(tabs)/(3_profile)';

/** The Preferences screen the Profile tab pushes above its root. */
const PREFERENCES = `${PROFILE_TAB_ROOT}/preferences`;

/**
 * How a language reload reopens where the user was.
 *
 * `replace` is enough for a target that is its own parent: the relaunch's
 * stack is empty, so the replaced route is exactly the screen to show.
 */
export type LanguageReturnNavigation =
  | Readonly<{ method: 'replace'; href: Href }>
  | Readonly<{ method: 'navigate'; href: Href; withAnchor: true }>;

/**
 * Each return target's reopen. The record is keyed by the closed target union,
 * so a new target cannot be added without naming how it reopens.
 *
 * A screen that sits above its tab's root (`preferences`) reopens with one
 * `navigate` that carries `withAnchor`. Neither `replace` nor `push` can
 * rebuild the stack under it from the relaunch's empty state: each navigator
 * below the target is created from the destination alone, so the reopened
 * screen becomes its Stack's only route and Back leaves the tab for Home
 * instead of returning to the Profile tab root. `withAnchor` seeds every
 * navigator's own anchor (`(tabs)` for the signed-in shell, `index` for the
 * Profile tab) beneath the target, so Back pops to that root and the tab keeps
 * its selection. The same rule is why a relaunch restore navigates with an
 * anchor instead of replacing the root.
 */
const LANGUAGE_RETURN_NAVIGATIONS = {
  login: { method: 'replace', href: '/(auth)/login' as Href },
  profile: { method: 'replace', href: PROFILE_TAB_ROOT as Href },
  preferences: { method: 'navigate', href: PREFERENCES as Href, withAnchor: true },
} satisfies Record<LanguageReturnTarget, LanguageReturnNavigation>;

/** The one navigation a return target reopens with. */
export function languageReturnNavigation(target: LanguageReturnTarget): LanguageReturnNavigation {
  return LANGUAGE_RETURN_NAVIGATIONS[target];
}
