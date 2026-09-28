/**
 * The provider's widget category, as react-native-android-widget writes it.
 *
 * Keep in step with `withWidgetProviderXml` in the library's `app.plugin.js`:
 * the generator hardcodes `home_screen`, so the library's own plugin cannot
 * declare the keyguard host.
 */
const HOME_SCREEN_CATEGORY = 'android:widgetCategory="home_screen"';
/** Home screen plus the lock screen / always-on display host. */
const HOME_AND_KEYGUARD_CATEGORY = 'android:widgetCategory="home_screen|keyguard"';

/**
 * Declare the keyguard host beside the home screen in a generated provider XML.
 *
 * Android 15 QPR1+ phones host widgets on the lock screen and the always-on
 * display, and a provider opts in through `android:widgetCategory`. The string
 * already carries the keyguard category after one rewrite, so a second pass
 * leaves it alone — the mod that calls this runs on every prebuild, over a file
 * an earlier prebuild may have written.
 *
 * Pure and import-free on purpose: a unit test requires this file directly, and
 * an `expo` import here would drag the whole config-plugin graph into it.
 *
 * @param {string} xml
 * @returns {string}
 */
function rewriteWidgetProviderCategory(xml) {
  return xml.replaceAll(HOME_SCREEN_CATEGORY, HOME_AND_KEYGUARD_CATEGORY);
}

/**
 * Rewrite the provider and prove the keyguard host landed.
 *
 * The replacement matches one exact literal, so a library bump that requotes,
 * reorders, or templates the attribute would match nothing and return the input
 * unchanged. The mod that writes the file would then skip the write while the
 * prebuild still succeeded, silently dropping the lock-screen host — exactly
 * the outcome this rewrite exists to prevent. Assert the outcome and throw
 * instead, so the drift fails the prebuild.
 *
 * `label` names the file in the error; the rewrite itself is pure.
 *
 * @param {string} xml
 * @param {string} [label]
 * @returns {string}
 */
function rewriteWidgetProviderCategoryOrThrow(xml, label) {
  const rewritten = rewriteWidgetProviderCategory(xml);
  if (!rewritten.includes(HOME_AND_KEYGUARD_CATEGORY)) {
    throw new Error(
      `withActiveAgentsAndroidWidget: ${label ?? 'provider XML'} does not declare ` +
        `${HOME_AND_KEYGUARD_CATEGORY} after the rewrite; react-native-android-widget ` +
        `must write ${HOME_SCREEN_CATEGORY} for this mod to rewrite`
    );
  }
  return rewritten;
}

module.exports = { rewriteWidgetProviderCategory, rewriteWidgetProviderCategoryOrThrow };
