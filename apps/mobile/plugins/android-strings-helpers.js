const fs = require('fs');
const path = require('path');

// Shared Android resource helpers for the config plugins that localize
// library strings (`withAndroidWidgetLocalizations`, `withAndroidSheetCloseLabel`).
// One implementation, because the qualifier rules and the string escaping are
// easy to get subtly wrong and both plugins must agree.

/**
 * Android resource qualifier for a BCP 47 tag.
 *
 * The `b+` form is the only one that carries a script (`zh-Hans`), and it has
 * been supported since API 24 — below the app's minimum. The legacy `-r` form
 * cannot express a script at all, so everything uses `b+` for one rule.
 */
const localeQualifier = tag => `b+${tag.replace(/-/g, '+')}`;

/**
 * Escape one string resource value.
 *
 * `&` and `<` are XML; the apostrophe, the quote and the backslash are Android's
 * own string escapes; a leading `@` or `?` would otherwise read as a resource
 * reference.
 */
const escapeValue = value =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll(/([\\'"])/g, '\\$1')
    .replace(/^([@?])/, '\\$1');

/** One minimal `strings.xml`-shaped file with the given name/value pairs. */
const stringsXml = entries =>
  [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<resources>',
    ...entries.map(([name, value]) => `  <string name="${name}">${escapeValue(value)}</string>`),
    '</resources>',
    '',
  ].join('\n');

/**
 * Write one `<stringsFile>` per non-English language into
 * `app/src/main/res/values-<qualifier>/`, overwriting an existing file.
 *
 * `copy` maps a language tag to an object; `pick` turns one entry into the
 * name/value pairs of its file. Languages whose entry has no value for a pair
 * throw — the caller decides what is required, so a missing translation fails
 * the prebuild instead of shipping an English label.
 */
function writeLocaleStrings({ config, copy, pick, stringsFile }) {
  const resPath = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
  if (!fs.existsSync(resPath)) {
    throw new Error(`writeLocaleStrings: no res directory at ${resPath}`);
  }
  for (const [tag, entry] of Object.entries(copy)) {
    if (tag === 'en') {
      continue;
    }
    const entries = pick(entry);
    if (entries.some(([, value]) => value == null || value === '')) {
      throw new Error(
        `writeLocaleStrings: language "${tag}" has no translation for ${stringsFile}`
      );
    }
    const folder = path.join(resPath, `values-${localeQualifier(tag)}`);
    fs.mkdirSync(folder, { recursive: true });
    fs.writeFileSync(path.join(folder, stringsFile), stringsXml(entries), 'utf8');
  }
}

module.exports = { escapeValue, localeQualifier, stringsXml, writeLocaleStrings };
