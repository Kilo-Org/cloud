const fs = require('node:fs');
const path = require('node:path');

const { withAndroidStyles, withDangerousMod, withMainActivity } = require('expo/config-plugins');

const {
  SPLASH_WINDOW_DRAWABLE_NAME,
  applySplashWindowBackground,
  injectMainActivityLaunchSurface,
  splashWindowDrawable,
} = require('./android-splash-window-background');

/**
 * Keeps the Android cold start on the brand splash: it writes the brand launch
 * surface (splash color + dark Kilo mark), pins the launch and post-splash
 * themes' `android:windowBackground` to it, and only hands the window back to
 * the app background once the app's React content appears — so no bare window
 * surface can show between the splash and React's first frame.
 *
 * Must be registered BEFORE `expo-splash-screen`: config-plugin mods run in
 * reverse registration order, so the earlier entry runs last and sees the
 * `Theme.App.SplashScreen` style and the `MainActivity` that the splash plugin
 * writes.
 *
 * See `android-splash-window-background.js` for the frames this covers.
 */
const withAndroidSplashWindowBackground = config => {
  config = withAndroidStyles(config, config => {
    config.modResults = applySplashWindowBackground(config.modResults);
    return config;
  });
  config = withDangerousMod(config, [
    'android',
    config => {
      const drawableDir = path.join(
        config.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'drawable'
      );
      fs.mkdirSync(drawableDir, { recursive: true });
      fs.writeFileSync(
        path.join(drawableDir, `${SPLASH_WINDOW_DRAWABLE_NAME}.xml`),
        splashWindowDrawable()
      );
      return config;
    },
  ]);
  return withMainActivity(config, config => {
    config.modResults.contents = injectMainActivityLaunchSurface(
      config.modResults.contents,
      config.modResults.language
    );
    return config;
  });
};

module.exports = withAndroidSplashWindowBackground;
