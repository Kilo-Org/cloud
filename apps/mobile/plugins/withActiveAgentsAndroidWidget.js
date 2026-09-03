const fs = require('fs');
const path = require('path');

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
  return loadAndroidWidgetsPlugin()(config, { widgets: described });
};
