const { withDangerousMod, withStringsXml } = require('expo/config-plugins');

const { writeLocaleStrings } = require('./android-strings-helpers.js');

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
      writeLocaleStrings({
        config: cfg,
        copy: Object.fromEntries(
          Object.entries(copy).map(([tag, entry]) => [
            tag,
            { displayName: entry?.displayName, description: entry?.description },
          ])
        ),
        pick: entry => [
          [labelName, entry.displayName],
          [descriptionName, entry.description],
        ],
        stringsFile: 'kilo_widget_strings.xml',
      });
      return cfg;
    },
  ]);
};
