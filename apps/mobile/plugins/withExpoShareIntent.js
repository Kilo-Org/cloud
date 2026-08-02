const fs = require('fs');
const Module = require('module');
const path = require('path');

const { withFinalizedMod, withXcodeProject } = require('expo/config-plugins');

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

// React Native's react_native_post_install writes CC/CXX/LD/LDPLUSPLUS pointing at
// $(REACT_NATIVE_PATH)/scripts/xcode/ccache-*.sh at the *project* level whenever
// ccache is installed on the builder (EAS images ship it) and apple.ccacheEnabled
// is set. REACT_NATIVE_PATH expands through ${PODS_ROOT}, which CocoaPods only
// defines for pod-integrated targets. ShareExtension links no pods, so PODS_ROOT
// expanded empty and CC became /../../../../node_modules/... — "unable to spawn
// process" killed the iOS build on EAS. Define PODS_ROOT the way CocoaPods would
// so the inherited compiler wrapper path resolves.
function withShareExtensionPodsRoot(config) {
  return withXcodeProject(config, config => {
    const project = config.modResults;
    // The stored target name is quoted ('"ShareExtension"') and upstream's
    // addTarget leaves no comment entry for pbxTargetByName to match, so
    // compare raw names with quotes tolerated.
    const unquote = value => (typeof value === 'string' ? value.replace(/^"|"$/g, '') : value);
    const target = Object.values(project.pbxNativeTargetSection()).find(
      entry => entry && unquote(entry.name) === SHARE_EXTENSION_TARGET
    );
    if (!target) {
      throw new Error(
        `Expected Xcode target "${SHARE_EXTENSION_TARGET}" so PODS_ROOT can be set, but it was not found`
      );
    }
    const configurationList = project.pbxXCConfigurationList()[target.buildConfigurationList];
    if (!configurationList) {
      throw new Error(
        `Expected build configuration list for Xcode target "${SHARE_EXTENSION_TARGET}", but it was not found`
      );
    }
    const configurations = project.pbxXCBuildConfigurationSection();
    for (const { value } of configurationList.buildConfigurations) {
      const buildConfiguration = configurations[value];
      if (
        buildConfiguration &&
        buildConfiguration.buildSettings &&
        !buildConfiguration.buildSettings.PODS_ROOT
      ) {
        // Quoted: '(' and ')' are array delimiters in pbxproj syntax, so the
        // xcode package's verbatim write would corrupt the project unquoted.
        buildConfiguration.buildSettings.PODS_ROOT = '"$(SRCROOT)/Pods"';
      }
    }
    return config;
  });
}

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
  // withXcodeProject mods execute in reverse registration order (each mod runs
  // its action, then delegates to the previously registered one). Register
  // withShareExtensionPodsRoot first so it runs after upstream's target-creation
  // mod, when the ShareExtension target exists.
  config = withShareExtensionPodsRoot(config);
  config = withExpoShareIntentUpstream(config, parameters);
  config = withKiloShareSheetDisplayName(config);
  return config;
};
