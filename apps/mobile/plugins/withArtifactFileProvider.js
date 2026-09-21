const fs = require('fs');
const path = require('path');

const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');
const { addBuildPhases } = require('expo-widgets/plugin/build/ios/xcode/addBuildPhases');
const { addPbxGroup } = require('expo-widgets/plugin/build/ios/xcode/addPbxGroup');
const { addProductFile } = require('expo-widgets/plugin/build/ios/xcode/addProductFile');
const { addTargetDependency } = require('expo-widgets/plugin/build/ios/xcode/addTargetDependency');
const {
  addToPbxNativeTargetSection,
} = require('expo-widgets/plugin/build/ios/xcode/addToPbxNativeTargetSection');
const {
  addToPbxProjectSection,
} = require('expo-widgets/plugin/build/ios/xcode/addToPbxProjectSection');
const {
  addXCConfigurationList,
} = require('expo-widgets/plugin/build/ios/xcode/addXCConfigurationList');

// Adds the read-only File Provider extension target that serves the artifact
// mirror to the iOS Files app.
//
// iOS-only by capability, not by scope: `com.apple.fileprovider-nonui` is an
// out-of-process app extension that only an Xcode target can produce. Android
// has no File Provider equivalent, so it serves the same mirror in-process from
// `context.filesDir` through the module's DocumentsProvider
// (`modules/artifacts-provider/android/`) and needs no prebuild plugin. The
// feature's one runtime `Platform.OS` branch, in
// `src/lib/artifacts/artifact-mirror-paths.ts`, records the same split.
//
// iOS has no in-process file provider: the Files app talks to that separate
// extension process, and an extension can only reach an app group container.
// The extension's source lives in
// `apps/mobile/targets/ArtifactsFileProvider/` (the app-side domain lives in
// `modules/artifacts-provider/ios/`), and this plugin composes its Xcode target
// with the same helpers expo-widgets uses for `ExpoWidgetsTarget`
// (`expo-widgets/plugin/build/ios/xcode/`, composed by
// `.../ios/withIosWidgets.js`) rather than re-implementing pbxproj surgery.
//
// Read-only is the contract: the extension refuses every write entry point and
// its items declare no writing, deleting or renaming capability, so nothing
// here adds a write phase or a write capability.
const TARGET_NAME = 'ArtifactsFileProvider';
const BUNDLE_IDENTIFIER = 'com.kilocode.kiloapp.ArtifactsFileProvider';
// The group the app already carries (expo-widgets' withAppGroupEntitlements) and
// the one `src/lib/artifacts/artifact-mirror-paths.ts` mirrors into.
const APP_GROUP_IDENTIFIER = 'group.com.kilocode.kiloapp';

const SOURCE_DIRECTORY = path.join(__dirname, '..', 'targets', TARGET_NAME);

/** The extension's own files, copied into the project at prebuild. */
function sourceFileNames() {
  const names = fs
    .readdirSync(SOURCE_DIRECTORY)
    .filter(name => !name.startsWith('.'))
    .sort();
  if (names.length === 0) {
    throw new Error(`withArtifactFileProvider: ${SOURCE_DIRECTORY} holds no extension files`);
  }
  return names;
}

// Mods run in reverse registration order, so the copy below happens before the
// target mod only for the Xcode project file; both only need the files to be in
// place when the build starts, which the copy guarantees.
function withFileProviderSourceFiles(config) {
  return withDangerousMod(config, [
    'ios',
    async modConfig => {
      const targetDirectory = path.join(modConfig.modRequest.platformProjectRoot, TARGET_NAME);
      fs.mkdirSync(targetDirectory, { recursive: true });
      for (const name of sourceFileNames()) {
        fs.copyFileSync(path.join(SOURCE_DIRECTORY, name), path.join(targetDirectory, name));
      }
      return modConfig;
    },
  ]);
}

function withFileProviderTarget(config) {
  return withXcodeProject(config, projectConfig => {
    const xcodeProject = projectConfig.modResults;
    if (xcodeProject.pbxTargetByName(TARGET_NAME)) {
      // Prebuild can run over a tree a previous pass already extended.
      return projectConfig;
    }
    const groupName = 'Embed Foundation Extensions';
    const marketingVersion = projectConfig.ios?.version ?? projectConfig.version ?? '1.0';
    const currentProjectVersion = projectConfig.ios?.buildNumber ?? '1';
    const deploymentTarget = projectConfig.ios?.deploymentTarget ?? '16.4';

    const xCConfigurationList = addXCConfigurationList(xcodeProject, {
      targetName: TARGET_NAME,
      bundleIdentifier: BUNDLE_IDENTIFIER,
      deploymentTarget,
      appleTeamId: projectConfig.ios?.appleTeamId,
      marketingVersion,
      currentProjectVersion,
    });
    const productFile = addProductFile(xcodeProject, { targetName: TARGET_NAME, groupName });
    const target = addToPbxNativeTargetSection(xcodeProject, {
      targetName: TARGET_NAME,
      targetUuid: xcodeProject.generateUuid(),
      productFile,
      xCConfigurationList,
    });
    addToPbxProjectSection(xcodeProject, target);
    addTargetDependency(xcodeProject, target);

    // The group is created with the target directory as its path, so its files
    // are named by their basename, exactly as expo-widgets passes the widget
    // files (relative to the target directory) to the same helpers.
    const relativePaths = sourceFileNames();
    addBuildPhases(xcodeProject, {
      targetUuid: target.uuid,
      groupName,
      productFile,
      widgetFiles: relativePaths.filter(file => file.endsWith('.swift')),
    });
    addPbxGroup(xcodeProject, { targetName: TARGET_NAME, widgetFiles: relativePaths });
    return projectConfig;
  });
}

// The extension links no pods: FileProvider, UniformTypeIdentifiers and
// Foundation are system frameworks, and pulling React Native or the Expo
// modules into a non-UI extension would only slow its launch. The target still
// gets its own Pods integration so CocoaPods configures it alongside the app.
const podfileFileProviderLinking = () => `
target "${TARGET_NAME}" do
    use_frameworks! :linkage => podfile_properties['ios.useFrameworks'].to_sym if podfile_properties['ios.useFrameworks']
    use_frameworks! :linkage => ENV['USE_FRAMEWORKS'].to_sym if ENV['USE_FRAMEWORKS']
end
`;

function withFileProviderPodsLinking(config) {
  return withDangerousMod(config, [
    'ios',
    async modConfig => {
      const podfilePath = path.join(modConfig.modRequest.platformProjectRoot, 'Podfile');
      const podfileContents = fs.readFileSync(podfilePath, 'utf8');
      if (podfileContents.includes(`target "${TARGET_NAME}" do`)) {
        return modConfig;
      }
      fs.writeFileSync(podfilePath, `${podfileContents}${podfileFileProviderLinking()}`, 'utf8');
      return modConfig;
    },
  ]);
}

// EAS builds the extension as its own provisioning profile; the entry tells EAS
// which target to sign and which app group it carries. Same shape as
// expo-widgets' `withEasConfig`.
function withFileProviderEasConfig(config) {
  const appExtensions = config.extra?.eas?.build?.experimental?.ios?.appExtensions ?? [];
  if (appExtensions.some(extension => extension.targetName === TARGET_NAME)) {
    return config;
  }
  return {
    ...config,
    extra: {
      ...config.extra,
      eas: {
        ...config.extra?.eas,
        build: {
          ...config.extra?.eas?.build,
          experimental: {
            ...config.extra?.eas?.build?.experimental,
            ios: {
              ...config.extra?.eas?.build?.experimental?.ios,
              appExtensions: [
                ...appExtensions,
                {
                  targetName: TARGET_NAME,
                  bundleIdentifier: BUNDLE_IDENTIFIER,
                  entitlements: {
                    'com.apple.security.application-groups': [APP_GROUP_IDENTIFIER],
                  },
                },
              ],
            },
          },
        },
      },
    },
  };
}

module.exports = function withArtifactFileProvider(config) {
  return withFileProviderEasConfig(
    withFileProviderPodsLinking(withFileProviderSourceFiles(withFileProviderTarget(config)))
  );
};
