const fs = require('fs');
const path = require('path');

// Wraps react-native-android-widget so its config plugin only applies once the
// Android widget actually exists. The widget config file is created by slice
// `and` (level 3) at apps/mobile/src/glanceable-android/widget-config.json;
// before then this plugin is a no-op, so level 2 prebuilds are unaffected.
const WIDGET_CONFIG_PATH = path.resolve(__dirname, '../src/glanceable-android/widget-config.json');

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
  return loadAndroidWidgetsPlugin()(config, { widgets });
};
