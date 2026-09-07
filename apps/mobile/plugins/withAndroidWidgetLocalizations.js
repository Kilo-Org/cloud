const fs = require('fs');
const path = require('path');

const { withDangerousMod, withStringsXml } = require('expo/config-plugins');

// Localizes the Android widget-picker entry.
//
// react-native-android-widget writes one `android:label` straight into the
// receiver and wraps the description in a single `values/strings.xml` entry, so
// the picker stays English on every device. Android resolves both through the
// resource system, which means the only thing missing is a `values-<tag>`
// folder per language holding the same two keys.
//
// The copy is bundle metadata, not app copy, so it lives in
// `widget-gallery-copy.json` beside this file — the same file the iOS gallery
// reads — and never goes through i18next.
//
// This must be registered BEFORE './plugins/withActiveAgentsAndroidWidget':
// mods run in reverse registration order, so the earlier entry runs last and
// sees the resources that plugin has already written.

/** The library derives both resource names from the widget name, lowercased. */
const stringName = (widgetName, suffix) => `widget_${widgetName.toLowerCase()}_${suffix}`;

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
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/([\\'"])/g, '\\$1')
    .replace(/^([@?])/, '\\$1');

const stringsXml = entries =>
  [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<resources>',
    ...entries.map(([name, value]) => `  <string name="${name}">${escapeValue(value)}</string>`),
    '</resources>',
    '',
  ].join('\n');

module.exports = function withAndroidWidgetLocalizations(config, options) {
  const languages = options?.languages ?? [];
  const copy = options?.copy ?? {};
  const widgetName = options?.widgetName;
  if (!widgetName || languages.length === 0) {
    throw new Error('withAndroidWidgetLocalizations requires `widgetName` and `languages`.');
  }
  const labelName = stringName(widgetName, 'label');
  const descriptionName = stringName(widgetName, 'description');

  // The default resources. The label is a plain string the receiver references
  // as `@string/…` (see widget-config.json); the description already exists,
  // written by the library, so only the label is added here.
  const withDefaults = withStringsXml(config, cfg => {
    const english = copy.en;
    if (!english) {
      throw new Error('withAndroidWidgetLocalizations requires English gallery copy.');
    }
    const resources = cfg.modResults.resources;
    resources.string = resources.string ?? [];
    const existing = resources.string.find(entry => entry.$?.name === labelName);
    if (existing) {
      existing._ = english.displayName;
    } else {
      resources.string.push({ $: { name: labelName }, _: english.displayName });
    }
    // The library writes the description as translatable="false", which aapt2
    // reads as a promise that no `values-<tag>` override exists. The 86 written
    // below are exactly that, so the flag has to go.
    const description = resources.string.find(entry => entry.$?.name === descriptionName);
    if (!description) {
      throw new Error(
        `withAndroidWidgetLocalizations: no "${descriptionName}" resource; it must run after the widget plugin.`
      );
    }
    delete description.$.translatable;
    return cfg;
  });

  return withDangerousMod(withDefaults, [
    'android',
    async cfg => {
      const resPath = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
      if (!fs.existsSync(resPath)) {
        throw new Error(`withAndroidWidgetLocalizations: no res directory at ${resPath}`);
      }
      for (const tag of languages) {
        const translated = copy[tag];
        if (tag === 'en' || !translated) {
          continue;
        }
        const folder = path.join(resPath, `values-${localeQualifier(tag)}`);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(
          path.join(folder, 'kilo_widget_strings.xml'),
          stringsXml([
            [labelName, translated.displayName],
            [descriptionName, translated.description],
          ]),
          'utf8'
        );
      }
      return cfg;
    },
  ]);
};
