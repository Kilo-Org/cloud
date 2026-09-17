const fs = require('fs');
const path = require('path');

const { withFinalizedMod } = require('expo/config-plugins');

// The Focus filter's `Localizable.strings`.
//
// The Swift intent in `modules/notification-focus-filter/ios` declares its
// title, description, and parameter label as English literals, and
// `LocalizedStringResource`, `IntentDescription`, and `@Parameter(title:)`
// resolve them against the app bundle's `Localizable.strings`. Expo's built-in
// `withLocales` creates and registers that file from the special
// `ios['Localizable.strings']` key (see `buildFocusFilterLocales`), but its
// writer emits the key bare — `Agent notifications = "…";` — and a bare key
// with spaces is not a parseable entry: Xcode's CopyStringsFile step rejects
// the whole file, no Focus-filter string resolves, and the control stays
// English on a localized device. The gallery copy next door
// (`withWidgetLocalizations.js`) has the same requirement and quotes through
// its own `stringsLine`; a catalog this app generates must do the same.
//
// So this plugin does not write the file from scratch — it lets `withLocales`
// keep the registration it already does and replaces the content of each
// language's file with the quoted, escaped catalog
// `buildFocusFilterStringsFiles` renders. A finalized mod runs after every
// other iOS mod, `withLocales` included, which is what makes the replacement
// the last write. A missing file fails the prebuild: Expo stopped registering
// the catalog, and shipping the English literals silently is the harm this
// plugin exists to prevent.
module.exports = function withFocusFilterLocalizations(config, { languages, files } = {}) {
  if (!Array.isArray(languages) || languages.length === 0) {
    throw new Error('withFocusFilterLocalizations needs a non-empty `languages` array');
  }
  const missing = languages.filter(tag => typeof files?.[tag] !== 'string' || files[tag] === '');
  if (missing.length > 0) {
    throw new Error(
      `withFocusFilterLocalizations: no Focus-filter catalog for ${missing.join(', ')}`
    );
  }

  return withFinalizedMod(config, [
    'ios',
    async modConfig => {
      for (const tag of languages) {
        const catalog = path.join(
          modConfig.modRequest.platformProjectRoot,
          modConfig.modRequest.projectName,
          'Supporting',
          `${tag}.lproj`,
          'Localizable.strings'
        );
        if (!fs.existsSync(catalog)) {
          throw new Error(
            `withFocusFilterLocalizations: ${catalog} is missing — Expo's withLocales did not register the Focus-filter catalog`
          );
        }
        fs.writeFileSync(catalog, files[tag], 'utf8');
      }
      return modConfig;
    },
  ]);
};
