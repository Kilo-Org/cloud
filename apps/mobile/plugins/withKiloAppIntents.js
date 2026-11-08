const fs = require('fs');
const path = require('path');

const { withAppDelegate, withDangerousMod, withXcodeProject } = require('expo/config-plugins');

// App Intents must compile in the app target: the static KiloAppActions pod
// has no bundle in the built app for the system to load intents metadata
// from. The pod keeps the Expo bridge and catalog store; these sources are
// copied into the generated app target at prebuild.

const SOURCE_FILES = [
  'KiloAppIntents.swift',
  'KiloSessionEntity.swift',
  'KiloVisibleSession.swift',
];
const APP_TARGET_SOURCES = path.join('modules', 'kilo-app-actions', 'ios', 'AppIntents');
const APPLICATION_PRODUCT_TYPE = 'com.apple.product-type.application';
const INSTALL_CALL = 'KiloVisibleSessionBridge.install(publisher: KiloVisibleSession.publish)';
const CREATE_REACT_DELEGATE = /^([ \t]*)let delegate = ReactNativeDelegate\(\)/m;
const LEGACY_PACKAGE =
  /\n@available\(iOS 17\.0, \*\)\nstruct KiloAppIntentsPackage: AppIntentsPackage \{[\s\S]*?\n\}\n?/;

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
      for (const name of SOURCE_FILES) {
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
    for (const file of SOURCE_FILES) {
      const filePath = groupPath ? file : path.posix.join(cfg.name, file);
      if (!project.hasFile(filePath)) {
        project.addSourceFile(filePath, { target: uuid }, groupKey);
      }
    }
    return cfg;
  });
}

function installPublisher(contents) {
  if (LEGACY_PACKAGE.test(contents)) {
    // The previous plugin owned both this struct and the AppIntents import it
    // needed; remove them together and leave every other import alone.
    contents = contents.replace(LEGACY_PACKAGE, '\n').replace(/^import AppIntents\n/m, '');
  }
  contents = contents.replace(/^import KiloAppActions$/m, 'internal import KiloAppActions');
  if (!contents.includes('internal import KiloAppActions\n')) {
    contents = 'internal import KiloAppActions\n' + contents;
  }
  if (contents.includes(INSTALL_CALL)) return contents;
  if (!CREATE_REACT_DELEGATE.test(contents)) {
    throw new Error('withKiloAppIntents: AppDelegate has no ReactNativeDelegate initialization');
  }
  return contents.replace(
    CREATE_REACT_DELEGATE,
    (match, indent) => `${indent}${INSTALL_CALL}\n${match}`
  );
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
