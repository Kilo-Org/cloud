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
 */
function rewriteWidgetProviderCategory(xml) {
  return xml.replaceAll(HOME_SCREEN_CATEGORY, HOME_AND_KEYGUARD_CATEGORY);
}

module.exports = { rewriteWidgetProviderCategory };
