const fs = require('fs');
const path = require('path');

const { withAppDelegate, withDangerousMod, withXcodeProject } = require('expo/config-plugins');

const { APP_TARGET_SOURCES, installPublisher, sourceFiles } = require('./kilo-app-intents-sources');

// App Intents must compile in the app target: the static KiloAppActions pod
// has no bundle in the built app for the system to load intents metadata
// from. The pod keeps the Expo bridge and catalog store; every Swift file in
// `ios/AppIntents` is copied into the generated app target at prebuild.

const APPLICATION_PRODUCT_TYPE = 'com.apple.product-type.application';

const unquote = value => String(value ?? '').replaceAll('"', '');

// `pbxTargetByName` returns the target body, which carries no uuid; match the
// application product type in the native target section instead.
function applicationTargetUuid(project) {
  const targets = project.pbxNativeTargetSection();
  const uuid = Object.keys(targets).find(
    key =>
      !key.endsWith('_comment') && unquote(targets[key].productType) === APPLICATION_PRODUCT_TYPE
  );
  if (!uuid) throw new Error('withKiloAppIntents: no application target in the Xcode project');
  return uuid;
}

function withCopiedSources(config) {
  return withDangerousMod(config, [
    'ios',
    async cfg => {
      const targetRoot = path.join(cfg.modRequest.platformProjectRoot, cfg.name);
      if (!fs.existsSync(path.join(targetRoot, 'Info.plist')))
        throw new Error(`withKiloAppIntents: the app target is not at ios/${cfg.name}`);
      const sourceRoot = path.join(cfg.modRequest.projectRoot, APP_TARGET_SOURCES);
      for (const name of sourceFiles(cfg.modRequest.projectRoot)) {
        const source = path.join(sourceRoot, name);
        if (!fs.existsSync(source)) throw new Error(`withKiloAppIntents: ${source} is missing`);
        fs.copyFileSync(source, path.join(targetRoot, name));
      }
      return cfg;
    },
  ]);
}

function withSources(config) {
  return withXcodeProject(config, cfg => {
    const project = cfg.modResults;
    const uuid = applicationTargetUuid(project);
    // Xcode rejects a second Sources phase as duplicate tasks; join the app
    // target's existing phase through its app group.
    const groups = project.hash.project.objects.PBXGroup;
    const groupKey = Object.keys(groups).find(
      key => !key.endsWith('_comment') && unquote(groups[key].name) === cfg.name
    );
    if (!groupKey) throw new Error(`withKiloAppIntents: no ${cfg.name} group in the Xcode project`);
    const groupPath = unquote(groups[groupKey].path);
    if (groupPath && groupPath !== cfg.name) {
      throw new Error(`withKiloAppIntents: unexpected app group path ${groupPath}`);
    }
    for (const file of sourceFiles(cfg.modRequest.projectRoot)) {
      const filePath = groupPath ? file : path.posix.join(cfg.name, file);
      if (!project.hasFile(filePath)) {
        project.addSourceFile(filePath, { target: uuid }, groupKey);
      }
    }
    return cfg;
  });
}

function withPublisherInstall(config) {
  return withAppDelegate(config, mod => {
    if (mod.modResults.language !== 'swift') {
      throw new Error('withKiloAppIntents: AppDelegate must be Swift.');
    }
    mod.modResults.contents = installPublisher(mod.modResults.contents);
    return mod;
  });
}

module.exports = function withKiloAppIntents(config) {
  config = withCopiedSources(config);
  config = withSources(config);
  config = withPublisherInstall(config);
  return config;
};
