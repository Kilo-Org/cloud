const fs = require('node:fs');
const path = require('node:path');

const { withAndroidStyles, withMainActivity, withPlugins } = require('expo/config-plugins');

const {
  SPLASH_WINDOW_DRAWABLE_NAME,
  THEME_NAME,
  applySplashWindowBackground,
  injectMainActivityLaunchSurface,
  splashWindowDrawable,
} = require('./android-splash-window-background');

/**
 * One launch implementation for iOS and Android: expo-splash-screen generates
 * both native surfaces from the same options; AnimatedSplashOverlay owns the
 * shared readiness gates, native hide and reveal animation.
 *
 * Capability exception: Android lacks iOS's root-backed launch-storyboard
 * loading view. Once its system splash exits (including before the app bundle
 * loads in a dev client), only android:windowBackground covers the gap to React.
 * iOS's Expo loading view already supplies that backing surface and resizes with
 * the root. The Android-only mods below fill this native gap; they do not own
 * splash dismissal. Their drawable reuses Expo's generated color and logo.
 *
 * Register the fallback BEFORE Expo internally: mods run in reverse order, so
 * it sees Expo's generated theme and activity. Callers cannot reverse the pair.
 */
const withBrandedSplash = (config, options) => {
  config = withAndroidStyles(config, config => {
    if (!config.modResults.resources.style?.some(theme => theme.$?.name === THEME_NAME)) {
      return config;
    }
    config.modResults = applySplashWindowBackground(config.modResults);
    // Wait for Expo's splash theme; dangerous mods run before styles are generated.
    if (!config.modRequest.introspect) {
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
    }
    return config;
  });
  config = withMainActivity(config, config => {
    config.modResults.contents = injectMainActivityLaunchSurface(
      config.modResults.contents,
      config.modResults.language
    );
    return config;
  });
  return withPlugins(config, [['expo-splash-screen', options]]);
};

module.exports = withBrandedSplash;
