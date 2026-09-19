const fs = require('fs');
const path = require('path');

const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');

// The iOS notification service extension that applies the per-Focus
// agent-progress choice while the app is not in the foreground.
//
// `setNotificationHandler` only sees a push in the foreground, so the choice
// `AgentProgressFocusFilter` stores would otherwise be ignored for every
// background or killed-app delivery. The server marks a progress push with
// `mutable-content` (`iosMutableContentForPushData`), iOS runs this extension
// before showing it, and the extension drops the push when the active Focus
// excluded agent progress.
//
// The extension's source lives in the Focus-filter module so the choice, the
// filter that writes it, and the reader that applies it are one implementation;
// the target itself is created here because an app extension is a separate
// build target with its own Info.plist and entitlements.
const MODULE_IOS_DIRECTORY = path.join('modules', 'notification-focus-filter', 'ios');
const TARGET_NAME = 'NotificationServiceExtension';
const PRINCIPAL_CLASS = 'NotificationService';
// The app's other extensions use this phase so their products land in PlugIns;
// the same name keeps one "Embed Foundation Extensions" phase on the app target.
const EMBED_PHASE_NAME = 'Embed Foundation Extensions';
// Matches `NotificationFocusFilterStorage.appGroupIdentifier`: the extension
// reads `UserDefaults(suiteName:)` from the group the Focus filter writes.
const DEFAULT_APP_GROUP_IDENTIFIER = 'group.com.kilocode.kiloapp';

// Copied into the generated target directory at prebuild. The entry point sits
// in the extension's own directory; the storage is the module's top-level file
// shared with the app pod.
const EXTENSION_SOURCE_FILES = [
  {
    name: 'NotificationService.swift',
    relativeSource: path.join(TARGET_NAME, 'NotificationService.swift'),
  },
  {
    name: 'NotificationFocusFilterStorage.swift',
    relativeSource: 'NotificationFocusFilterStorage.swift',
  },
];

function infoPlist(marketingVersion, currentProjectVersion) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>CFBundleDisplayName</key>
\t<string>Kilo</string>
\t<key>CFBundleShortVersionString</key>
\t<string>${marketingVersion}</string>
\t<key>CFBundleVersion</key>
\t<string>${currentProjectVersion}</string>
\t<key>NSExtension</key>
\t<dict>
\t\t<key>NSExtensionPointIdentifier</key>
\t\t<string>com.apple.usernotifications.service</string>
\t\t<key>NSExtensionPrincipalClass</key>
\t\t<string>$(PRODUCT_MODULE_NAME).${PRINCIPAL_CLASS}</string>
\t</dict>
</dict>
</plist>
`;
}

function entitlements(appGroupIdentifier) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.security.application-groups</key>
\t<array>
\t\t<string>${appGroupIdentifier}</string>
\t</array>
</dict>
</plist>
`;
}

function writeExtensionFiles(config, appGroupIdentifier) {
  return withDangerousMod(config, [
    'ios',
    async config => {
      const moduleDirectory = path.join(config.modRequest.projectRoot, MODULE_IOS_DIRECTORY);
      const targetDirectory = path.join(config.modRequest.platformProjectRoot, TARGET_NAME);
      fs.mkdirSync(targetDirectory, { recursive: true });

      for (const file of EXTENSION_SOURCE_FILES) {
        fs.copyFileSync(
          path.join(moduleDirectory, file.relativeSource),
          path.join(targetDirectory, file.name)
        );
      }

      const marketingVersion = config.ios?.version ?? config.version ?? '1.0';
      const currentProjectVersion = config.ios?.buildNumber ?? '1';
      fs.writeFileSync(
        path.join(targetDirectory, 'Info.plist'),
        infoPlist(marketingVersion, currentProjectVersion)
      );
      fs.writeFileSync(
        path.join(targetDirectory, `${TARGET_NAME}.entitlements`),
        entitlements(appGroupIdentifier)
      );
      return config;
    },
  ]);
}

/**
 * Register the extension with EAS Build. EAS provisions an App ID and profile
 * per app extension from `extra.eas.build.experimental.ios.appExtensions`; the
 * app group in the extension's entitlements has no matching capability without
 * this entry, and the build fails at signing.
 */
function registerEasAppExtension(config, appGroupIdentifier) {
  const build = config.extra?.eas?.build ?? {};
  const experimental = build.experimental ?? {};
  const ios = experimental.ios ?? {};
  const extensions = ios.appExtensions ?? [];
  const entry = {
    targetName: TARGET_NAME,
    bundleIdentifier: `${config.ios?.bundleIdentifier}.${TARGET_NAME}`,
    entitlements: { 'com.apple.security.application-groups': [appGroupIdentifier] },
  };
  return {
    ...config,
    extra: {
      ...config.extra,
      eas: {
        ...config.extra?.eas,
        build: {
          ...build,
          experimental: {
            ...experimental,
            ios: {
              ...ios,
              appExtensions: [
                ...extensions.filter(candidate => candidate.targetName !== TARGET_NAME),
                entry,
              ],
            },
          },
        },
      },
    },
  };
}

function findCopyFilesPhase(project, targetUuid, comment) {
  const section = project.hash.project.objects.PBXCopyFilesBuildPhase;
  const target = project.pbxNativeTargetSection()[targetUuid];
  const entry = target?.buildPhases?.find(phase => phase.comment === comment);
  return entry && section ? section[entry.value] : null;
}

/**
 * The extension target, modeled on expo-widgets' own widget-target plugin: the
 * same `app_extension` product type, the same "Embed Foundation Extensions"
 * copy phase on the app target, and the same project dependency, so the app
 * build produces and embeds the `.appex`.
 */
function addExtensionTarget(config) {
  return withXcodeProject(config, config => {
    const project = config.modResults;
    if (project.pbxTargetByName(TARGET_NAME)) {
      // Prebuild can run over a tree a previous pass already extended.
      return config;
    }
    if (!config.ios?.bundleIdentifier) {
      throw new Error(
        `ios.bundleIdentifier is required so ${TARGET_NAME} can be embedded in the app`
      );
    }

    const sourceNames = EXTENSION_SOURCE_FILES.map(file => file.name);
    const marketingVersion = config.ios?.version ?? config.version ?? '1.0';
    const currentProjectVersion = config.ios?.buildNumber ?? '1';
    const mainTargetUuid = project.getFirstTarget().uuid;

    const configurationList = project.addXCConfigurationList(
      ['Debug', 'Release'].map(name => ({
        name,
        isa: 'XCBuildConfiguration',
        buildSettings: {
          PRODUCT_NAME: '"$(TARGET_NAME)"',
          SWIFT_VERSION: '5.0',
          TARGETED_DEVICE_FAMILY: '"1,2"',
          INFOPLIST_FILE: `${TARGET_NAME}/Info.plist`,
          CURRENT_PROJECT_VERSION: `"${currentProjectVersion}"`,
          IPHONEOS_DEPLOYMENT_TARGET: '"16.4"',
          PRODUCT_BUNDLE_IDENTIFIER: `"${config.ios.bundleIdentifier}.${TARGET_NAME}"`,
          GENERATE_INFOPLIST_FILE: '"YES"',
          INFOPLIST_KEY_CFBundleDisplayName: 'Kilo',
          MARKETING_VERSION: `"${marketingVersion}"`,
          APPLICATION_EXTENSION_API_ONLY: '"YES"',
          SWIFT_OPTIMIZATION_LEVEL: '"-Onone"',
          CODE_SIGN_STYLE: 'Automatic',
          CODE_SIGN_ENTITLEMENTS: `"${TARGET_NAME}/${TARGET_NAME}.entitlements"`,
          // React Native's post_install points CC at a ccache wrapper under
          // $(PODS_ROOT)/../react-native. CocoaPods defines PODS_ROOT only for
          // pod-integrated targets, and this extension links no pods, so it must
          // define the same value or CC resolves to a missing executable and the
          // build dies with "unable to spawn process" (the ShareExtension fix in
          // plugins/withExpoShareIntent.js).
          PODS_ROOT: '"$(SRCROOT)/Pods"',
          ...(config.ios.appleTeamId ? { DEVELOPMENT_TEAM: config.ios.appleTeamId } : {}),
        },
      })),
      'Release',
      `Build configuration list for PBXNativeTarget "${TARGET_NAME}"`
    );

    const productFile = project.addProductFile(TARGET_NAME, {
      basename: `${TARGET_NAME}.appex`,
      group: EMBED_PHASE_NAME,
      explicitFileType: 'wrapper.app-extension',
      settings: { ATTRIBUTES: ['RemoveHeadersOnCopy'] },
      includeInIndex: 0,
      path: `${TARGET_NAME}.appex`,
      sourceTree: 'BUILT_PRODUCTS_DIR',
    });

    const target = {
      uuid: project.generateUuid(),
      pbxNativeTarget: {
        isa: 'PBXNativeTarget',
        name: TARGET_NAME,
        productName: TARGET_NAME,
        productReference: productFile.fileRef,
        productType: '"com.apple.product-type.app-extension"',
        buildConfigurationList: configurationList.uuid,
        buildPhases: [],
        buildRules: [],
        dependencies: [],
      },
    };
    // `addTargetDependency` serializes through these two sections; a project
    // with a single target may not have created them yet.
    const sections = project.hash.project.objects;
    sections.PBXTargetDependency ??= {};
    sections.PBXContainerItemProxy ??= {};
    project.addToPbxNativeTargetSection(target);
    project.addToPbxProjectSection(target);
    project.addTargetDependency(mainTargetUuid, [target.uuid]);
    const projectSection = project.pbxProjectSection()[project.getFirstProject().uuid];
    projectSection.attributes.TargetAttributes[target.uuid] = { LastSwiftMigration: 1250 };

    // The extension's own phases.
    project.addBuildPhase(sourceNames, 'PBXSourcesBuildPhase', 'Sources', target.uuid);
    project.addBuildPhase([], 'PBXFrameworksBuildPhase', 'Frameworks', target.uuid);
    // Embed it in the app. A phase the widget plugin already created under this
    // name is reused, so the app keeps a single copy-files phase.
    let embedPhase = findCopyFilesPhase(project, mainTargetUuid, EMBED_PHASE_NAME);
    if (!embedPhase) {
      project.addBuildPhase(
        [],
        'PBXCopyFilesBuildPhase',
        EMBED_PHASE_NAME,
        mainTargetUuid,
        'app_extension',
        '""'
      );
      embedPhase = findCopyFilesPhase(project, mainTargetUuid, EMBED_PHASE_NAME);
    }
    if (!embedPhase) {
      throw new Error(`Failed to create the "${EMBED_PHASE_NAME}" copy phase for ${TARGET_NAME}`);
    }
    if (!embedPhase.files.some(file => file.value === productFile.uuid)) {
      embedPhase.files.push({
        value: productFile.uuid,
        comment: `${productFile.basename} in ${EMBED_PHASE_NAME}`,
      });
    }
    if (!project.pbxBuildFileSection()[productFile.uuid]) {
      project.addToPbxBuildFileSection(productFile);
    }

    const group = project.addPbxGroup(
      [...sourceNames, `${TARGET_NAME}.entitlements`],
      TARGET_NAME,
      TARGET_NAME
    );
    const groups = project.hash.project.objects.PBXGroup;
    for (const key of Object.keys(groups)) {
      if (groups[key].name === undefined && groups[key].path === undefined) {
        project.addToPbxGroup(group.uuid, key);
      }
    }

    return config;
  });
}

module.exports = function withNotificationFocusFilter(config, props = {}) {
  const appGroupIdentifier = props.appGroupIdentifier ?? DEFAULT_APP_GROUP_IDENTIFIER;
  config = registerEasAppExtension(config, appGroupIdentifier);
  config = writeExtensionFiles(config, appGroupIdentifier);
  config = addExtensionTarget(config);
  return config;
};
