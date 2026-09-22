const {
  AndroidConfig,
  withAndroidColors,
  withAndroidColorsNight,
  withAndroidStyles,
} = require('expo/config-plugins');
const { assignColorValue } = AndroidConfig.Colors;

/**
 * Pins the Android window background to the app's own theme background while
 * rotation is enabled.
 *
 * With `orientation: 'default'` the activity handles orientation config
 * changes itself, and Android resizes the window surface across the rotation.
 * Until React paints the first frame in the new orientation, the window shows
 * `android:windowBackground` — the AppCompat DayNight default (foreign white
 * in light mode, near-black in dark mode), which is exactly the blank frame a
 * screen capture taken during the rotation records. Pointing the attribute at
 * the same tokens `src/global.css` resolves (`--background`: #FBFAF5 light,
 * #0E0E10 dark, via values-night) makes every such gap render the app's own
 * screen color in both UI modes instead of a foreign blank.
 *
 * The splash theme (`Theme.App.SplashScreen`, yellow) is untouched: it only
 * governs the launch frame before `postSplashScreenTheme` (AppTheme) applies.
 */

/** Mirrors src/global.css `--background` (light). */
const APP_BACKGROUND_LIGHT = '#FBFAF5';
/** Mirrors src/global.css `--background` (dark, prefers-color-scheme). */
const APP_BACKGROUND_DARK = '#0E0E10';

const COLOR_NAME = 'app_background';
const THEME_NAME = 'AppTheme';
const WINDOW_BACKGROUND_ITEM = 'android:windowBackground';

function setItem(theme, name, value) {
  theme.item ??= [];
  const existing = theme.item.find(item => item.$?.name === name);
  if (existing) {
    existing._ = value;
    return;
  }
  theme.item.push({ $: { name }, _: value });
}

function withRotationSurfaceColors(config) {
  return withAndroidColors(config, config => {
    assignColorValue(config.modResults, {
      name: COLOR_NAME,
      value: APP_BACKGROUND_LIGHT,
    });
    return config;
  });
}

function withRotationSurfaceColorsNight(config) {
  return withAndroidColorsNight(config, config => {
    assignColorValue(config.modResults, {
      name: COLOR_NAME,
      value: APP_BACKGROUND_DARK,
    });
    return config;
  });
}

function withRotationSurfaceStyles(config) {
  return withAndroidStyles(config, config => {
    const themes = config.modResults.resources.style ?? [];
    const appTheme = themes.find(theme => theme.$?.name === THEME_NAME);
    if (appTheme) {
      setItem(appTheme, WINDOW_BACKGROUND_ITEM, `@color/${COLOR_NAME}`);
    }
    return config;
  });
}

const withAndroidRotationSurface = config =>
  withRotationSurfaceStyles(withRotationSurfaceColorsNight(withRotationSurfaceColors(config)));

module.exports = withAndroidRotationSurface;
