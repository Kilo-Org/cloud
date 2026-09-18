const fs = require('fs');
const path = require('path');

const { withDangerousMod, withInfoPlist, withXcodeProject } = require('expo/config-plugins');

const { assertIntentCopy, renderLocalizableStrings } = require('./app-intent-copy.js');
const { mergeIntoResourcesPhase } = require('./app-intent-resources.js');

// Writes the main app target's `Localizable.strings`, one `<tag>.lproj` file
// per language.
//
// An App Intent's `title`, its parameter names and its `AppShortcutsProvider`
// phrases are `LocalizedStringResource`s that iOS resolves against
// `Localizable.strings` in the app bundle. Expo's prebuild writes the app's
// `Info.plist` and the widget extension's copy, but nothing else writes the app
// target's own `Localizable.strings`, so the Shortcuts app would list every
// action in English on a localized device.
//
// This fork follows the capability, not a scope: App Intents and their `.lproj`
// `Localizable.strings` metadata are iOS-only, so no Android prebuild calls
// this plugin. Android has no App Intents to localize — its action surface is
// the exported entry points plus `res/xml/shortcuts.xml`, which
// `platform-parity.test.ts` compares against the iOS tree.
//
// This is the app-target twin of `withWidgetLocalizations`: the App Intent copy
// lives in `app-intent-copy.json` beside this file (bundle metadata, never
// i18next), and pre-rendered `additionalStrings` — the Focus filter's catalog,
// which the same bundle's `Localizable.strings` resolves — are appended to each
// language's file. The two are one bundle resource, so one writer must emit
// them: feeding the Focus-filter key to Expo's built-in `withLocales` instead
// made the app target carry two `Localizable.strings` (this one and
// `Supporting/<tag>.lproj/Localizable.strings`) and Xcode failed the build with
// "Multiple commands produce …/Localizable.strings".
//
// It throws for a language with no copy — or no appended strings — so a
// prebuild fails loudly instead of shipping an English label.
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

module.exports = function withAppIntentLocalizations(
  config,
  { languages, copy, additionalStrings } = {}
) {
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
  const withoutAdditional = languages.filter(tag => typeof additionalStrings?.[tag] !== 'string');
  if (withoutAdditional.length > 0) {
    throw new Error(
      `withAppIntentLocalizations: no additional Localizable.strings content for ${withoutAdditional.join(', ')}`
    );
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
      // `addBuildPhase` always creates a phase, and the app target already has
      // its own: fold this one into that one so the target keeps a single
      // Copy Bundle Resources phase.
      mergeIntoResourcesPhase(project, targetUuid, phase);
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
            // Both catalogs are already rendered `.strings` bodies that end in
            // a newline: the App Intent entries first, the Focus-filter copy
            // appended after them, so the one bundle file carries both.
            fs.writeFileSync(
              path.join(dir, STRINGS_FILE),
              `${renderLocalizableStrings(copy, tag)}${additionalStrings[tag]}`,
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
