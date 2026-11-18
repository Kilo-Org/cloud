const fs = require('fs');
const path = require('path');

const { withDangerousMod, withStringsXml } = require('expo/config-plugins');

const { writeLocaleStrings } = require('./android-strings-helpers.js');

// Overrides androidx.compose.ui's `close_sheet` string for every app language.
//
// Material3's `ModalBottomSheet` labels its dismiss scrim with
// `androidx.compose.ui.R.string.close_sheet` (`Strings.CloseSheet` in
// `androidx.compose.material3.internal`), and the `@expo/ui` community
// BottomSheet — the native sheet behind `@/components/ui/sheet` — takes no
// accessibility-label prop, so the library copy is what TalkBack reads on
// every sheet. androidx ships "Fechar planilha" (close spreadsheet) for
// Portuguese and "Tabelle schließen" (close table) for German, among other
// spreadsheet words for languages whose word for a spreadsheet cell grid
// resembles their word for a sheet. Resource merging resolves the app's own
// `close_sheet` ahead of the library's, so this writes the default
// (English) entry and one `values-b+<tag>` folder per other language.
//
// The copy is `common.close` from the app's own catalogs, the same reviewed
// strings the close buttons render. Nothing here goes through i18next; the
// catalogs are read at prebuild time, so a catalog change lands in the next
// native build. `en.json` is the default entry, and a catalog that lacks
// `common.close` fails the prebuild rather than falling back to English.

const RESOURCE_NAME = 'close_sheet';
const LOCALE_FILE = 'sheet_close_strings.xml';

const readCloseCopy = pluginsDir => {
  const localesDir = path.join(pluginsDir, '..', 'src', 'i18n', 'locales');
  const copy = {};
  for (const file of fs.readdirSync(localesDir)) {
    if (!file.endsWith('.json')) {
      continue;
    }
    const tag = file.slice(0, -5);
    const catalog = JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));
    const value = catalog?.common?.close;
    if (typeof value !== 'string') {
      throw new Error(`withAndroidSheetCloseLabel: ${file} has no common.close string`);
    }
    copy[tag] = value;
  }
  if (!copy.en) {
    throw new Error('withAndroidSheetCloseLabel: no en catalog with common.close');
  }
  return copy;
};

function withAndroidSheetCloseLabel(config, { pluginsDir } = {}) {
  const copy = readCloseCopy(pluginsDir ?? __dirname);

  const withDefault = withStringsXml(config, cfg => {
    const resources = cfg.modResults.resources;
    resources.string = resources.string ?? [];
    const existing = resources.string.find(entry => entry.$?.name === RESOURCE_NAME);
    if (existing) {
      existing._ = copy.en;
    } else {
      resources.string.push({ $: { name: RESOURCE_NAME }, _: copy.en });
    }
    return cfg;
  });

  return withDangerousMod(withDefault, [
    'android',
    async cfg => {
      writeLocaleStrings({
        config: cfg,
        copy: Object.fromEntries(Object.entries(copy).map(([tag, value]) => [tag, { value }])),
        pick: entry => [[RESOURCE_NAME, entry.value]],
        stringsFile: LOCALE_FILE,
      });
      return cfg;
    },
  ]);
}

module.exports = withAndroidSheetCloseLabel;
module.exports.readCloseCopy = readCloseCopy;
module.exports.RESOURCE_NAME = RESOURCE_NAME;
module.exports.LOCALE_FILE = LOCALE_FILE;
