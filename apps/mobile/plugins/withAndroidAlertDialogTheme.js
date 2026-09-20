const {
  AndroidConfig,
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
} = require('expo/config-plugins');
const { assignColorValue } = AndroidConfig.Colors;

/**
 * Points the Android alert dialog at the app's own surface tokens.
 *
 * React Native renders `Alert.alert()` through AppCompat's `AlertDialog`,
 * whose panel and action labels come from the activity theme's DayNight
 * defaults: `?attr/colorBackgroundFloating` (`background_floating_material_*`)
 * and `?attr/colorAccent` (`material_deep_teal_*`). None of those are Kilo
 * colors, so in dark mode the panel is the stock #424242 slab — 2.4x lighter
 * than every app surface (`--popover` #1F1F24) — and the CANCEL/SIGN OUT
 * labels are the stock teal. The confirmation then reads as a system dialog
 * pasted over the screen instead of a modal in the app's language
 * (explorer-signout-confirm, 2026-09-19).
 *
 * Android is the one platform that has the capability this overlay uses, and
 * the only one that needs it: React Native renders `Alert.alert()` as
 * AppCompat's `AlertDialog` there, and that dialog resolves its panel and
 * accent from the activity theme, so the theme is where app tokens can reach
 * it. iOS renders the same call as a `UIAlertController`, which already follows
 * the device's light/dark appearance (`userInterfaceStyle: 'automatic'` in
 * app.config.ts) and exposes no supported override for its panel or accent —
 * the platform has no app-token capability to target, so it gets no half here
 * and none may be invented. One shared `Alert.alert()` call site serves both
 * platforms; this plugin is the only platform-specific piece on the path, and
 * src/lib/alert-dialog-platform-parity.test.ts holds it to that.
 *
 * The generated styles.xml is a prebuild output (`/android` is git-ignored),
 * so the theme and the colors it names are declared here, beside the
 * rotation-surface plugin that pins `android:windowBackground` the same way.
 * `alertDialogTheme` is resolved from the activity theme and applied as an
 * overlay on top of it, so only alert dialogs change; popups, spinners, and
 * every other native surface keep their own colors.
 *
 * Values mirror src/global.css: the panel is `--popover` (#FFFFFF light,
 * #1F1F24 dark) and the action labels are `--primary` (#4F5A10 light,
 * #E8F27A dark), the same accent the app's own buttons use.
 */

/** Mirrors src/global.css `--popover` (light). */
const DIALOG_BACKGROUND_LIGHT = '#FFFFFF';
/** Mirrors src/global.css `--popover` (dark, prefers-color-scheme). */
const DIALOG_BACKGROUND_DARK = '#1F1F24';
/** Mirrors src/global.css `--primary` (light). */
const DIALOG_ACTION_LIGHT = '#4F5A10';
/** Mirrors src/global.css `--primary` (dark, prefers-color-scheme). */
const DIALOG_ACTION_DARK = '#E8F27A';

const BACKGROUND_COLOR_NAME = 'app_dialog_background';
const ACTION_COLOR_NAME = 'app_dialog_action';
const THEME_NAME = 'AppTheme';
const DIALOG_THEME_NAME = 'AppAlertDialogTheme';
const DIALOG_THEME_PARENT = 'ThemeOverlay.AppCompat.Dialog.Alert';
const ALERT_DIALOG_THEME_ITEM = 'alertDialogTheme';
const BACKGROUND_ITEM = 'colorBackgroundFloating';
const FRAMEWORK_BACKGROUND_ITEM = 'android:colorBackgroundFloating';
const ACTION_ITEM = 'colorAccent';

function setItem(style, name, value) {
  style.item ??= [];
  const existing = style.item.find(item => item.$?.name === name);
  if (existing) {
    existing._ = value;
    return;
  }
  style.item.push({ $: { name }, _: value });
}

function withAlertDialogColors(config) {
  return withAndroidColors(config, config => {
    assignColorValue(config.modResults, {
      name: BACKGROUND_COLOR_NAME,
      value: DIALOG_BACKGROUND_LIGHT,
    });
    assignColorValue(config.modResults, {
      name: ACTION_COLOR_NAME,
      value: DIALOG_ACTION_LIGHT,
    });
    return config;
  });
}

function withAlertDialogColorsNight(config) {
  return withAndroidColorsNight(config, config => {
    assignColorValue(config.modResults, {
      name: BACKGROUND_COLOR_NAME,
      value: DIALOG_BACKGROUND_DARK,
    });
    assignColorValue(config.modResults, {
      name: ACTION_COLOR_NAME,
      value: DIALOG_ACTION_DARK,
    });
    return config;
  });
}

function withAlertDialogStyles(config) {
  return withAndroidStyles(config, config => {
    const resources = config.modResults.resources;
    // Assigned back, not just defaulted: a styles.xml without a `<style>` yet
    // would otherwise take the throwaway `[]` and drop the overlay below.
    resources.style = resources.style ?? [];
    const appTheme = resources.style.find(theme => theme.$?.name === THEME_NAME);
    if (appTheme) {
      setItem(appTheme, ALERT_DIALOG_THEME_ITEM, `@style/${DIALOG_THEME_NAME}`);
    }
    const dialogTheme = resources.style.find(theme => theme.$?.name === DIALOG_THEME_NAME);
    if (dialogTheme) {
      return config;
    }
    resources.style.push({
      $: { name: DIALOG_THEME_NAME, parent: DIALOG_THEME_PARENT },
      item: [
        { $: { name: BACKGROUND_ITEM }, _: `@color/${BACKGROUND_COLOR_NAME}` },
        { $: { name: FRAMEWORK_BACKGROUND_ITEM }, _: `@color/${BACKGROUND_COLOR_NAME}` },
        { $: { name: ACTION_ITEM }, _: `@color/${ACTION_COLOR_NAME}` },
      ],
    });
    return config;
  });
}

const withAndroidAlertDialogTheme = config =>
  withAlertDialogStyles(withAlertDialogColorsNight(withAlertDialogColors(config)));

module.exports = withAndroidAlertDialogTheme;
