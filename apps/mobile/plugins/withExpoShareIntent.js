const fs = require('fs');
const Module = require('module');
const path = require('path');

const { withFinalizedMod } = require('expo/config-plugins');

// expo-share-intent@6.1.1 requires @expo/plist without declaring it. Under pnpm's
// isolated linker the nested plugin cannot resolve that package from its own
// directory. Resolve the copy that ships with @expo/config-plugins and patch
// Module resolution only while loading the upstream plugin.
const expoConfigPluginsEntry = require.resolve('expo/config-plugins');
const configPluginsPkg = require.resolve('@expo/config-plugins/package.json', {
  paths: [path.dirname(expoConfigPluginsEntry)],
});
const expoPlistEntry = require.resolve('@expo/plist', {
  paths: [path.dirname(configPluginsPkg)],
});

function loadUpstreamPlugin() {
  const originalResolveFilename = Module._resolveFilename;
  Module._resolveFilename = function resolveWithPlistFallback(request, parent, isMain, options) {
    if (request === '@expo/plist') {
      return expoPlistEntry;
    }
    return originalResolveFilename.call(this, request, parent, isMain, options);
  };
  try {
    // Clear cache so a previous failed load does not stick.
    const resolved = require.resolve('expo-share-intent/app.plugin.js');
    delete require.cache[resolved];
    const mod = require(resolved);
    return typeof mod === 'function' ? mod : mod.default;
  } finally {
    Module._resolveFilename = originalResolveFilename;
  }
}

const withExpoShareIntentUpstream = loadUpstreamPlugin();

// Upstream uses iosShareExtensionName for both the Xcode target name and
// CFBundleDisplayName. The app target is already "Kilo", so "Kilo" collides and
// the extension target is skipped. Keep a distinct target name and force the
// share-sheet label to "Kilo" after files are written.
const SHARE_EXTENSION_TARGET = 'ShareExtension';
const SHARE_SHEET_DISPLAY_NAME = 'Kilo';

function withKiloShareSheetDisplayName(config) {
  // finalized runs after dangerous mods that write ShareExtension-Info.plist.
  return withFinalizedMod(config, [
    'ios',
    async config => {
      const infoPath = path.join(
        config.modRequest.platformProjectRoot,
        SHARE_EXTENSION_TARGET,
        'ShareExtension-Info.plist'
      );
      if (!fs.existsSync(infoPath)) {
        throw new Error(
          `Expected ShareExtension-Info.plist so CFBundleDisplayName can be rewritten to "${SHARE_SHEET_DISPLAY_NAME}", but it was missing at ${infoPath}`
        );
      }
      const original = fs.readFileSync(infoPath, 'utf8');
      const updated = original.replace(
        /(<key>CFBundleDisplayName<\/key>\s*<string>)[^<]*(<\/string>)/,
        `$1${SHARE_SHEET_DISPLAY_NAME}$2`
      );
      if (updated === original) {
        throw new Error(
          `Failed to rewrite CFBundleDisplayName to "${SHARE_SHEET_DISPLAY_NAME}" in ${infoPath}`
        );
      }
      fs.writeFileSync(infoPath, updated);
      return config;
    },
  ]);
}

module.exports = function withExpoShareIntent(config, props = {}) {
  const { iosShareExtensionName: _ignoredDisplayName, ...rest } = props;
  const parameters = {
    ...rest,
    // Distinct from the main "Kilo" app target (see collision note above).
    iosShareExtensionName: SHARE_EXTENSION_TARGET,
  };
  config = withExpoShareIntentUpstream(config, parameters);
  config = withKiloShareSheetDisplayName(config);
  return config;
};
