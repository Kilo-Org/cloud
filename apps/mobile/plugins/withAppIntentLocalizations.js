const fs = require('fs');
const path = require('path');

const { withDangerousMod, withInfoPlist, withXcodeProject } = require('expo/config-plugins');

const { assertIntentCopy, renderLocalizableStrings } = require('./app-intent-copy.js');

// Localizes the App Intents on the main app target.
//
// An App Intent's `title`, its parameter names and its `AppShortcutsProvider`
// phrases are `LocalizedStringResource`s that iOS resolves against
// `Localizable.strings` in the app bundle. Expo's prebuild writes the app's
// `Info.plist` and the widget extension's copy, but nothing writes the app
// target's own `Localizable.strings`, so the Shortcuts app would list every
// action in English on a localized device.
//
// This is the app-target twin of `withWidgetLocalizations`: the copy lives in
// `app-intent-copy.json` beside this file (bundle metadata, never i18next), and
// one `<tag>.lproj/Localizable.strings` is written per language and attached to
// the app target's Resources build phase. It throws for a language with no copy,
// so a prebuild fails loudly instead of shipping an English label.
//
// The main app target is not addressable by name the way the extension is:
// `pbxTargetByName` returns the target body, which carries no uuid, and
// `addBuildPhase` silently falls back to the first target when the uuid is
// undefined. The uuid is resolved from `pbxNativeTargetSection()` instead,
// matching on the product type Expo's own target helpers use.

/** The bundle name of this file's `.lproj` entries. */
const STRINGS_FILE = 'Localizable.strings';

/** The one native target product type that is the app itself (`TargetType.APPLICATION`). */
const APPLICATION_PRODUCT_TYPE = 'com.apple.product-type.application';

/** The xcodeproj quotes a product type it wrote; compare it unquoted. */
const trimQuotes = value => String(value ?? '').replace(/^"|"$/g, '');

/**
 * The uuid of the app target — the native target that builds an application,
 * not the widget extension or any other target the plugins add.
 */
function appTargetUuid(project) {
  const targets = project.pbxNativeTargetSection();
  const uuid = Object.keys(targets).find(
    key =>
      !key.endsWith('_comment') && trimQuotes(targets[key].productType) === APPLICATION_PRODUCT_TYPE
  );
  if (!uuid) {
    throw new Error(
      'withAppIntentLocalizations: no application target in the Xcode project — run this after prebuild created it'
    );
  }
  return uuid;
}

module.exports = function withAppIntentLocalizations(config, { languages, copy } = {}) {
  if (!Array.isArray(languages) || languages.length === 0) {
    throw new Error('withAppIntentLocalizations needs a non-empty `languages` array');
  }
  const withoutCopy = languages.filter(tag => copy?.[tag] === undefined);
  if (withoutCopy.length > 0) {
    throw new Error(`withAppIntentLocalizations: no app-intent copy for ${withoutCopy.join(', ')}`);
  }
  if (!copy.en) {
    throw new Error('withAppIntentLocalizations: the app-intent copy needs an `en` entry');
  }
  for (const tag of languages) {
    assertIntentCopy(copy, tag);
  }

  // The app target's own source folder, where the app's Info.plist lives. An
  // Expo prebuild names it after the config name, so a missing folder means
  // this plugin ran against a project it does not know.
  const appFolder = config.name;
  const projectRoot = path.posix.join(appFolder);
  const resourceFiles = languages.map(tag =>
    path.posix.join(projectRoot, `${tag}.lproj`, STRINGS_FILE)
  );

  const withResources = cfg =>
    withXcodeProject(cfg, projectConfig => {
      const project = projectConfig.modResults;
      const targetUuid = appTargetUuid(project);
      const phase = project.addBuildPhase(
        resourceFiles,
        'PBXResourcesBuildPhase',
        'Resources',
        targetUuid
      );
      const attached = project.pbxNativeTargetSection()[targetUuid].buildPhases;
      if (!attached.some(entry => entry.value === phase.uuid)) {
        throw new Error(
          `withAppIntentLocalizations: the Resources phase did not attach to the ${appFolder} target`
        );
      }
      return projectConfig;
    });

  return withResources(
    withInfoPlist(
      withDangerousMod(config, [
        'ios',
        async modConfig => {
          const targetRoot = path.join(modConfig.modRequest.platformProjectRoot, appFolder);
          const infoPlistPath = path.join(targetRoot, 'Info.plist');
          if (!fs.existsSync(infoPlistPath)) {
            throw new Error(
              `withAppIntentLocalizations: ${infoPlistPath} is missing — the app target is not at ios/${appFolder}`
            );
          }
          for (const tag of languages) {
            const dir = path.join(targetRoot, `${tag}.lproj`);
            fs.mkdirSync(dir, { recursive: true });
            fs.writeFileSync(
              path.join(dir, STRINGS_FILE),
              renderLocalizableStrings(copy, tag),
              'utf8'
            );
          }
          return modConfig;
        },
      ]),
      cfg => {
        // The same list `app.config.ts` declares for `CFBundleLocalizations`:
        // iOS treats the app as English-only without it, and then the spoken
        // and drawn App Intent surfaces never consult the `.lproj` files.
        cfg.modResults.CFBundleLocalizations = [...languages];
        cfg.modResults.CFBundleDevelopmentRegion = 'en';
        return cfg;
      }
    )
  );
};
