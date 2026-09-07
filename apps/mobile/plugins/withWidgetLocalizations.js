const fs = require('fs');
const path = require('path');
const plist = require('@expo/plist').default;
const { withDangerousMod, withXcodeProject } = require('expo/config-plugins');

// Localizes the widget extension.
//
// expo-widgets writes the extension's Info.plist with four keys and no
// localization list, so iOS treats the extension as English-only. Two things
// break: the Live Activity and every widget family lay out left-to-right on an
// Arabic or Hebrew device, and the widget gallery copy stays English. The main
// app declares the same list for the same reason — see `CFBundleLocalizations`
// in app.config.ts.
//
// The gallery copy is bundle metadata, not app copy: expo-widgets emits
// `.configurationDisplayName("…")` and `.description("…")` as Swift string
// literals, which bind to SwiftUI's `LocalizedStringKey` overloads and resolve
// against `Localizable.strings` in the extension bundle. So the English strings
// are the keys, and this writes one `<tag>.lproj/Localizable.strings` per
// language. It never goes through i18next, which is why the translations live in
// `widget-gallery-copy.json` beside this file rather than in the app catalogs.
//
// Both mods must run after the `expo-widgets` plugin, which rewrites the
// Info.plist and creates the target. Mods run in reverse registration order, so
// this plugin is registered BEFORE 'expo-widgets' in app.config.ts.
const TARGET_NAME = 'ExpoWidgetsTarget';

/** One `.strings` entry. Only the quote and the backslash need escaping. */
const stringsLine = (key, value) =>
  `"${key.replace(/[\\"]/g, '\\$&')}" = "${value.replace(/[\\"]/g, '\\$&')}";`;

module.exports = function withWidgetLocalizations(config, { languages, copy } = {}) {
  if (!Array.isArray(languages) || languages.length === 0) {
    throw new Error('withWidgetLocalizations needs a non-empty `languages` array');
  }
  const missing = languages.filter(tag => !copy?.[tag]);
  if (missing.length > 0) {
    throw new Error(`withWidgetLocalizations: no gallery copy for ${missing.join(', ')}`);
  }
  const english = copy.en;
  if (!english) {
    throw new Error('withWidgetLocalizations: the gallery copy needs an `en` entry');
  }

  // The build phase that copies the `.lproj` directories into the appex. The
  // file references are relative to the project root, so they resolve without
  // being added to the target's group.
  const withResources = cfg =>
    withXcodeProject(cfg, projectConfig => {
      const project = projectConfig.modResults;
      // The uuid, not `pbxTargetByName`: that returns the target body, which
      // carries no uuid, and `addBuildPhase` silently falls back to the first
      // target — the app — when the uuid is undefined.
      const targets = project.pbxNativeTargetSection();
      const targetUuid = Object.keys(targets).find(
        key => !key.endsWith('_comment') && targets[key].name === TARGET_NAME
      );
      if (!targetUuid) {
        throw new Error(
          `withWidgetLocalizations: the ${TARGET_NAME} target is missing — this plugin ran before expo-widgets`
        );
      }
      const files = languages.map(tag => `${TARGET_NAME}/${tag}.lproj/Localizable.strings`);
      const phase = project.addBuildPhase(
        files,
        'PBXResourcesBuildPhase',
        'Resources',
        targetUuid,
        'app_extension',
        '""'
      );
      if (!targets[targetUuid].buildPhases.some(entry => entry.value === phase.uuid)) {
        throw new Error(
          `withWidgetLocalizations: the Resources phase did not attach to ${TARGET_NAME}`
        );
      }
      return projectConfig;
    });

  return withResources(
    withDangerousMod(config, [
      'ios',
      async modConfig => {
        const targetRoot = path.join(modConfig.modRequest.platformProjectRoot, TARGET_NAME);
        const infoPlistPath = path.join(targetRoot, 'Info.plist');
        if (!fs.existsSync(infoPlistPath)) {
          throw new Error(`withWidgetLocalizations: ${infoPlistPath} is missing`);
        }
        const parsed = plist.parse(fs.readFileSync(infoPlistPath, 'utf8'));
        parsed.CFBundleLocalizations = [...languages];
        parsed.CFBundleDevelopmentRegion = 'en';
        fs.writeFileSync(infoPlistPath, plist.build(parsed));

        for (const tag of languages) {
          const dir = path.join(targetRoot, `${tag}.lproj`);
          fs.mkdirSync(dir, { recursive: true });
          const lines = [
            stringsLine(english.displayName, copy[tag].displayName),
            stringsLine(english.description, copy[tag].description),
          ];
          fs.writeFileSync(path.join(dir, 'Localizable.strings'), `${lines.join('\n')}\n`, 'utf8');
        }
        return modConfig;
      },
    ])
  );
};
