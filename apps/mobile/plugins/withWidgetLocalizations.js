const fs = require('fs');
const path = require('path');
const plist = require('@expo/plist').default;
const { withDangerousMod } = require('expo/config-plugins');

// Declares the app's languages on the widget extension.
//
// expo-widgets writes the extension's Info.plist with four keys and no
// localization list, so iOS treats the extension as English-only. Two things
// break: the Live Activity and every widget family lay out left-to-right on an
// Arabic or Hebrew device, and the widget gallery copy cannot localize. The
// main app declares the same list for the same reason — see `CFBundleLocalizations`
// in app.config.ts.
//
// This must run after the `expo-widgets` plugin: dangerous mods run in the
// order they are registered, and expo-widgets rewrites the file.
const TARGET_NAME = 'ExpoWidgetsTarget';

module.exports = function withWidgetLocalizations(config, { languages } = {}) {
  if (!Array.isArray(languages) || languages.length === 0) {
    throw new Error('withWidgetLocalizations needs a non-empty `languages` array');
  }
  return withDangerousMod(config, [
    'ios',
    async modConfig => {
      const infoPlistPath = path.join(
        modConfig.modRequest.platformProjectRoot,
        TARGET_NAME,
        'Info.plist'
      );
      if (!fs.existsSync(infoPlistPath)) {
        throw new Error(`withWidgetLocalizations: ${infoPlistPath} is missing`);
      }
      const parsed = plist.parse(fs.readFileSync(infoPlistPath, 'utf8'));
      parsed.CFBundleLocalizations = [...languages];
      // The extension has no .lproj resources, so name the development language
      // explicitly; otherwise iOS picks the first entry of the list above.
      parsed.CFBundleDevelopmentRegion = 'en';
      fs.writeFileSync(infoPlistPath, plist.build(parsed));
      return modConfig;
    },
  ]);
};
