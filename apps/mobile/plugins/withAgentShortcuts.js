const fs = require('fs');
const path = require('path');

const { withAndroidManifest, withDangerousMod, withStringsXml } = require('expo/config-plugins');

const {
  AGENT_CONTROLS,
  AGENT_SHORTCUTS_META_DATA,
  AGENT_SHORTCUTS_RESOURCE,
  agentShortcutsXml,
  agentShortcutStrings,
} = require('../src/lib/agent-controls.js');

// Android's one-tap agent controls: two static app shortcuts, reached by
// long-pressing the launcher icon. They are the Android twin of the iOS
// ControlWidgets (plugins/withAgentControls.js) and carry the same two contract
// urls, so a tap opens the same route on either platform and nothing is
// re-implemented. There is no quick-settings tile — the request excludes it —
// and no Action-button twin, because that surface is iOS hardware.
//
// A static shortcut file is invisible until the launcher activity carries the
// `android.app.shortcuts` meta-data, so this plugin writes three things:
//   1. that meta-data on `.MainActivity`;
//   2. `res/xml/kilo_agent_shortcuts.xml` — one shortcut per contract entry,
//      each carrying exactly one VIEW intent at the contract url;
//   3. the shortcut labels: English in the default `values/strings.xml` and one
//      `values-b+<tag>/kilo_agent_shortcut_strings.xml` per other language.
//      Android resolves `@string/…` through the resource system, so those
//      folders are the localization.
//
// The copy is bundle metadata, not app copy: it lives in
// `agent-controls-copy.json` beside this file — the same file the iOS controls
// read — and never goes through i18next.
//
// No `android:icon` is set. The launcher falls back to the app icon, so the
// shortcuts add no drawable asset.
const SHORTCUTS_META_DATA_NAME = 'android.app.shortcuts';
const SHORTCUTS_STRINGS_FILE = 'kilo_agent_shortcut_strings.xml';
const AGENT_CONTROLS_COPY = require('./agent-controls-copy.json');

/** A label resource and the copy key whose value lands on it, in contract order. */
const LABEL_RESOURCES = AGENT_SHORTCUTS_META_DATA.flatMap(metadata => [
  { resource: metadata.shortLabelResource, copyKey: metadata.copyKey },
  { resource: metadata.longLabelResource, copyKey: metadata.descriptionCopyKey },
]);

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

/**
 * One `[resource, value]` pair per label for a language. The values come from
 * `agentShortcutStrings` — the same pairs the iOS controls write into their
 * `<tag>.lproj/Localizable.strings` — keyed by the English string that pairs a
 * value with its resource.
 * @param {Record<string, [string, string][]>} stringsByTag
 * @param {string} tag
 * @returns {[string, string][]}
 */
function labelEntries(stringsByTag, tag) {
  const values = new Map(stringsByTag[tag] ?? []);
  return LABEL_RESOURCES.map(({ resource, copyKey }) => [
    resource,
    values.get(AGENT_CONTROLS_COPY.en[copyKey]),
  ]);
}

/** The launcher activity the shortcut intents target. */
function withShortcutsMetaData(config) {
  return withAndroidManifest(config, cfg => {
    const application = cfg.modResults.manifest.application?.[0];
    const activity = application?.activity?.find(
      entry => entry.$?.['android:name'] === '.MainActivity'
    );
    if (!activity) {
      throw new Error(
        'withAgentShortcuts: no `.MainActivity` activity in the Android manifest — the launcher lists no shortcut without the meta-data on it'
      );
    }
    activity['meta-data'] = activity['meta-data'] ?? [];
    const existing = activity['meta-data'].find(
      entry => entry.$?.['android:name'] === SHORTCUTS_META_DATA_NAME
    );
    const item = {
      $: {
        'android:name': SHORTCUTS_META_DATA_NAME,
        'android:resource': `@xml/${AGENT_SHORTCUTS_RESOURCE}`,
      },
    };
    if (existing) {
      existing.$ = item.$;
    } else {
      activity['meta-data'].push(item);
    }
    return cfg;
  });
}

/** The English labels, in the default `values/strings.xml` every locale falls back to. */
function withDefaultLabels(config) {
  return withStringsXml(config, cfg => {
    const resources = cfg.modResults.resources;
    resources.string = resources.string ?? [];
    for (const [name, value] of labelEntries(agentShortcutStrings(AGENT_CONTROLS_COPY), 'en')) {
      const existing = resources.string.find(entry => entry.$?.name === name);
      if (existing) {
        existing._ = value;
      } else {
        resources.string.push({ $: { name }, _: value });
      }
    }
    return cfg;
  });
}

module.exports = function withAgentShortcuts(config) {
  const withMetaData = withShortcutsMetaData(config);
  const withLabels = withDefaultLabels(withMetaData);

  return withDangerousMod(withLabels, [
    'android',
    async cfg => {
      const resPath = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
      if (!fs.existsSync(resPath)) {
        throw new Error(`withAgentShortcuts: no res directory at ${resPath}`);
      }
      const targetPackage = cfg.android?.package;
      if (!targetPackage) {
        throw new Error(
          'withAgentShortcuts: `android.package` is required to target the app\u2019s launcher activity.'
        );
      }

      const xmlDir = path.join(resPath, 'xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(
        path.join(xmlDir, `${AGENT_SHORTCUTS_RESOURCE}.xml`),
        agentShortcutsXml({
          urls: AGENT_CONTROLS,
          targetPackage,
          targetClass: `${targetPackage}.MainActivity`,
        }),
        'utf8'
      );

      // English lives in the default resources; Android falls back to it for a
      // language whose folder is missing, so only the other tags are written.
      const stringsByTag = agentShortcutStrings(AGENT_CONTROLS_COPY);
      for (const tag of Object.keys(stringsByTag)) {
        if (tag === 'en') {
          continue;
        }
        const folder = path.join(resPath, `values-${localeQualifier(tag)}`);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(
          path.join(folder, SHORTCUTS_STRINGS_FILE),
          stringsXml(labelEntries(stringsByTag, tag)),
          'utf8'
        );
      }
      return cfg;
    },
  ]);
};
