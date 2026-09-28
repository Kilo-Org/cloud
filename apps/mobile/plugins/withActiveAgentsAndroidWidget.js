const fs = require('fs');
const path = require('path');

const { withAppBuildGradle, withDangerousMod } = require('expo/config-plugins');

const { rewriteWidgetProviderCategoryOrThrow } = require('./android-widget-category');

const GALLERY_COPY = require('./widget-gallery-copy.json');

// Wraps react-native-android-widget so its config plugin only applies once the
// Android widget actually exists. The widget config file is created by slice
// `and` (level 3) at apps/mobile/src/glanceable-android/widget-config.json;
// before then this plugin is a no-op, so level 2 prebuilds are unaffected.
//
// The gallery label and description come from widget-gallery-copy.json, the
// same file the iOS gallery reads, so the two pickers never drift. The label is
// passed as a resource reference because the library writes it straight into
// the receiver; withAndroidWidgetLocalizations creates that resource and its 86
// translations. The description is passed as text because the library already
// wraps it in a string resource of its own.
const WIDGET_CONFIG_PATH = path.resolve(__dirname, '../src/glanceable-android/widget-config.json');

const WORK_FORCE_MARKER = 'kilo-work-runtime-alignment';

// expo-widgets pulls androidx.glance, which depends on work-runtime-ktx 2.7.1,
// while react-native-android-widget depends on work-runtime 2.8.1. Version
// 2.8.0 folded the ktx classes into the main artifact, so the two together fail
// :app:checkDebugDuplicateClasses. Pin both to 2.8.1, where the ktx artifact is
// an empty shim.
function withWorkRuntimeAlignment(config) {
  return withAppBuildGradle(config, cfg => {
    if (cfg.modResults.contents.includes(WORK_FORCE_MARKER)) {
      return cfg;
    }
    cfg.modResults.contents += `
// ${WORK_FORCE_MARKER}
configurations.configureEach {
    resolutionStrategy {
        force 'androidx.work:work-runtime:2.8.1'
        force 'androidx.work:work-runtime-ktx:2.8.1'
    }
}
`;
    return cfg;
  });
}

/**
 * Declare the lock screen / always-on-display host on the provider XML.
 *
 * The library hardcodes `android:widgetCategory="home_screen"`, so its own
 * plugin cannot opt the widget into the Android 15 QPR1+ keyguard host. This
 * mod rewrites the generated `widgetprovider_<name>.xml` after the library has
 * written it.
 *
 * The wrapper registers this mod *before* it calls the library plugin, because
 * dangerous mods run in reverse registration order: the library's `withWidgets`
 * mod has to write the file first, and `app.config.ts` documents the same
 * ordering rule for the localization plugins. The rewrite is idempotent.
 *
 * The res path is the one an Android project has, `<platformProjectRoot>/app/
 * src/main/res/xml`, the same base `withAndroidWidgetLocalizations` writes its
 * `values-<tag>` folders under. The library reaches it through a path relative
 * to the prebuild's working directory (it captures `projectRoot` only after the
 * dangerous mods have run), so the file it leaves behind is this one. A missing
 * provider means that rule changed, and the widget silently losing its keyguard
 * host is worse than a failed prebuild: throw. The same rule guards the
 * rewrite: `rewriteWidgetProviderCategoryOrThrow` throws when the attribute it
 * matches is no longer there, so a library bump that reshapes the attribute
 * fails the prebuild instead of quietly dropping the lock-screen host.
 */
function withKeyguardWidgetCategory(config, widgets) {
  return withDangerousMod(config, [
    'android',
    cfg => {
      const xmlFolder = path.join(cfg.modRequest.platformProjectRoot, 'app/src/main/res/xml');
      for (const widget of widgets) {
        const xmlName = `widgetprovider_${widget.name.toLowerCase()}.xml`;
        const xmlPath = path.join(xmlFolder, xmlName);
        if (!fs.existsSync(xmlPath)) {
          throw new Error(
            `withActiveAgentsAndroidWidget: no ${xmlName} at ${xmlPath}; ` +
              'react-native-android-widget must write the provider XML before this mod runs'
          );
        }
        const xml = fs.readFileSync(xmlPath, 'utf8');
        // The literal replacement silently no-ops when the library changes the
        // attribute's shape, so assert the keyguard host landed: a provider
        // that lost it must fail the prebuild rather than ship.
        const rewritten = rewriteWidgetProviderCategoryOrThrow(xml, xmlName);
        if (rewritten !== xml) {
          fs.writeFileSync(xmlPath, rewritten);
        }
      }
      return cfg;
    },
  ]);
}

function loadAndroidWidgetsPlugin() {
  const resolved = require.resolve('react-native-android-widget/app.plugin.js');
  const mod = require(resolved);
  return typeof mod === 'function' ? mod : mod.default;
}

module.exports = function withActiveAgentsAndroidWidget(config) {
  if (!fs.existsSync(WIDGET_CONFIG_PATH)) {
    // No Android widget yet: keep the config untouched.
    return config;
  }
  const widgetConfig = JSON.parse(fs.readFileSync(WIDGET_CONFIG_PATH, 'utf8'));
  const widgets = Array.isArray(widgetConfig.widgets) ? widgetConfig.widgets : [];
  if (widgets.length === 0) {
    return config;
  }
  const described = widgets.map(widget => ({
    ...widget,
    label: `@string/widget_${widget.name.toLowerCase()}_label`,
    description: GALLERY_COPY.en.description,
  }));
  // The category mod is registered before the library plugin: see its comment.
  const withCategory = withKeyguardWidgetCategory(config, described);
  return withWorkRuntimeAlignment(loadAndroidWidgetsPlugin()(withCategory, { widgets: described }));
};
