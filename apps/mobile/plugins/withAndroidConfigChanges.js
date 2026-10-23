const { withAndroidManifest } = require('expo/config-plugins');

/**
 * Configuration changes the app handles in place instead of letting Android
 * recreate `MainActivity`.
 *
 * The Expo template declares `keyboard|keyboardHidden|orientation|screenSize|
 * screenLayout|uiMode|smallestScreenSize|assetsPaths`, so rotation, dark mode
 * and multi-window already keep the running UI. A system font-size change
 * (`fontScale`), a display-size change (`density`), or a language/direction
 * change (`locale`, `layoutDirection`) is not in that list, so Android destroys
 * the activity and the app restarts at its first route with all screen state
 * gone.
 *
 * Handling them in place is what React Native expects: `ReactHostImpl`
 * re-reads the display metrics on a configuration change and requests a layout
 * of every attached surface (`enableFontScaleChangesUpdatingLayout`, on by
 * default), which emits `didUpdateDimensions` to JS. Text re-measures in `sp`
 * at the new scale, `useWindowDimensions().fontScale` consumers re-render, and
 * the current route keeps its state.
 *
 * Entries are appended to whatever the template writes, so a template refresh
 * that adds another handled change neither drops nor duplicates these.
 */
const HANDLED_CONFIG_CHANGES = ['fontScale', 'density', 'locale', 'layoutDirection'];

/** The activity Android throws away on an unhandled configuration change. */
const MAIN_ACTIVITY_SUFFIX = '.MainActivity';

/**
 * Appends the handled configuration changes to an `android:configChanges`
 * value, keeping the declared ones in order and skipping ones already present.
 * An empty or missing value becomes exactly the handled list.
 */
function addHandledConfigChanges(value) {
  const declared = (value ?? '')
    .split('|')
    .map(entry => entry.trim())
    .filter(Boolean);
  const missing = HANDLED_CONFIG_CHANGES.filter(change => !declared.includes(change));
  return [...declared, ...missing].join('|');
}

/**
 * Writes the handled configuration changes onto the main activity of a
 * manifest object (the shape `withAndroidManifest` hands the mod). Returns the
 * manifest unchanged when the activity is absent, so a prebuild with a
 * different template stays inert instead of failing.
 */
function withHandledConfigChanges(manifest) {
  const activities = manifest.manifest.application?.[0]?.activity ?? [];
  const mainActivity = activities.find(activity =>
    activity.$?.['android:name']?.endsWith(MAIN_ACTIVITY_SUFFIX)
  );
  if (!mainActivity) {
    return manifest;
  }
  mainActivity.$['android:configChanges'] = addHandledConfigChanges(
    mainActivity.$['android:configChanges']
  );
  return manifest;
}

function withAndroidConfigChanges(config) {
  return withAndroidManifest(config, config => {
    config.modResults = withHandledConfigChanges(config.modResults);
    return config;
  });
}

module.exports = withAndroidConfigChanges;
module.exports.HANDLED_CONFIG_CHANGES = HANDLED_CONFIG_CHANGES;
module.exports.MAIN_ACTIVITY_SUFFIX = MAIN_ACTIVITY_SUFFIX;
module.exports.addHandledConfigChanges = addHandledConfigChanges;
module.exports.withHandledConfigChanges = withHandledConfigChanges;
