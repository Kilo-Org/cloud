/**
 * Options for the `expo-dev-client` config plugin.
 *
 * The developer menu is not the product, and on iOS it opens over the app at
 * launch: `DevMenuManager` (expo-dev-menu/ios/DevMenuManager.swift) auto-shows
 * it while onboarding is unfinished or `EXDevMenuShowsAtLaunch` (default true,
 * DevMenuPreferences.swift) is set. Its SwiftUI chrome then sits on top of
 * whatever product screen the app opened, and its icons carry raw SF Symbol
 * names as accessibility labels -- `chevron.left.chevron.right` on the "Open
 * DevTools" row (ios/SwiftUI/DevMenuDeveloperTools.swift) and `gearshape.fill`
 * on the floating tool button (ios/FAB/DevMenuFABView.swift). A scene dump of
 * the product screen under it reads those names aloud as-is, so VoiceOver
 * announces `chevron dot left dot chevron dot right` where the user opened the
 * sign-in screen.
 *
 * `toolsButton` hides the floating tool button; `showMenuAtLaunch` and
 * `skipOnboarding` keep the menu itself from covering the app at launch, which
 * also keeps automated UI runs on the product screens. The menu stays one
 * keyboard shortcut (Ctrl + d) or a shake away for a developer.
 *
 * Plain .js because the Expo config loader cannot consume workspace TS (same
 * reason env-keys.js and sentry-dsn.js exist).
 */
export const DEV_CLIENT_PLUGIN_OPTIONS = {
  toolsButton: false,
  showMenuAtLaunch: false,
  skipOnboarding: true,
};
