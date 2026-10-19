import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

type StringItem = { $: { name: string }; _?: string; '#text'?: string };
type StringsXml = { resources: { string: StringItem[] } };

interface ExpoConfigPlugin {
  mods?: {
    android?: {
      strings?: (config: ModConfig) => Promise<ModConfig>;
      dangerous?: (config: ModConfig) => Promise<ModConfig>;
    };
  };
}

interface ModConfig {
  modRequest: { platformProjectRoot: string };
  modResults: { resources: { string: StringItem[] } };
}

const require = createRequire(import.meta.url);
const pluginModule = require('./withAndroidSheetCloseLabel.js') as {
  LOCALE_FILE: string;
  RESOURCE_NAME: string;
  (config: ModConfig, options: { pluginsDir: string }): ExpoConfigPlugin;
  readCloseCopy: (pluginsDir: string) => Record<string, string>;
};
const withAndroidSheetCloseLabel = pluginModule;
const { LOCALE_FILE, RESOURCE_NAME, readCloseCopy } = pluginModule;

const PLUGINS_DIR = path.dirname(require.resolve('./withAndroidSheetCloseLabel.js'));

/** The minimal surface of fast-xml-parser the harness uses. */
interface XmlParser {
  parse: (xml: string) => unknown;
}
interface XmlBuilderLike {
  build: (value: unknown) => string;
}

/** Run the plugin's full android mod pipeline against a throwaway prebuilt android tree. */
async function runMod(): Promise<{ resPath: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-close-label-'));
  const projectRoot = path.join(root, 'android');
  const resPath = path.join(projectRoot, 'app', 'src', 'main', 'res');
  fs.mkdirSync(path.join(resPath, 'values'), { recursive: true });
  fs.writeFileSync(path.join(resPath, 'values', 'strings.xml'), '<resources></resources>');
  const config: ModConfig = {
    modRequest: { platformProjectRoot: projectRoot },
    modResults: { resources: { string: [] } },
  };
  const plugin = withAndroidSheetCloseLabel(config, { pluginsDir: PLUGINS_DIR });
  const mods = plugin.mods?.android;
  if (typeof mods?.strings !== 'function' || typeof mods?.dangerous !== 'function') {
    throw new Error('plugin exposes no android strings/dangerous mod');
  }
  // The real prebuild pipeline reads values/strings.xml into modResults before
  // the strings mod and writes modResults back afterwards (the base-mod
  // provider's read/write); simulate both around the plugin's mod.
  await mods.strings(config);
  const { XMLParser: Parser, XMLBuilder } = require('fast-xml-parser') as {
    XMLParser: new (o: object) => XmlParser;
    XMLBuilder: new (o: object) => XmlBuilderLike;
  };
  const parser = new Parser({
    ignoreAttributes: false,
    attributeNamePrefix: '$',
    isArray: () => false,
  });
  const builder = new XMLBuilder({
    ignoreAttributes: false,
    attributeNamePrefix: '$',
    format: false,
  });
  const written = builder.build(config.modResults);
  fs.writeFileSync(path.join(resPath, 'values', 'strings.xml'), written);
  await mods.dangerous(config);
  return { resPath };
}

function readStrings(file: string): StringsXml {
  // The plugin writes plain XML; parse it into the shape expo's
  // withStringsXml modResults use, normalizing single-entry collections and
  // fast-xml-parser's `$name` prefix for one-attribute elements.
  const { XMLParser: Parser } = require('fast-xml-parser') as {
    XMLParser: new (o: object) => XmlParser;
  };
  const parser = new Parser({
    ignoreAttributes: false,
    attributeNamePrefix: '$',
    isArray: () => false,
  });
  const parsed = parser.parse(fs.readFileSync(file, 'utf8')) as {
    resources?: {
      string?:
        | { $name?: string; $?: { name: string }; _?: string; '#text'?: string }
        | (string & string)[];
    };
  };
  const raw = parsed.resources?.string;
  const entries = (raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]).map(item =>
    typeof item === 'object' && item !== null && '$name' in item
      ? { $: { name: String(item.$name) }, _: item['#text'] }
      : (item as StringItem)
  );
  return { resources: { string: entries } };
}

describe('readCloseCopy', () => {
  it('reads common.close for every catalog beside the plugin', () => {
    const copy = readCloseCopy(PLUGINS_DIR);
    const catalogCount = fs
      .readdirSync(path.join(PLUGINS_DIR, '..', 'src', 'i18n', 'locales'))
      .filter(file => file.endsWith('.json')).length;
    expect(Object.keys(copy)).toHaveLength(catalogCount);
    expect(copy.en).toBe('Close');
    expect(copy['pt-BR']).toBe('Fechar');
    expect(copy.de).toBe('Schließen');
  });

  it('throws for a catalog without common.close', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sheet-close-copy-'));
    const locales = path.join(root, 'src', 'i18n', 'locales');
    fs.mkdirSync(locales, { recursive: true });
    fs.writeFileSync(path.join(locales, 'en.json'), JSON.stringify({ common: { close: 'Close' } }));
    fs.writeFileSync(path.join(locales, 'de.json'), JSON.stringify({ common: {} }));
    // readCloseCopy resolves the locales dir relative to the given plugins dir.
    expect(() => readCloseCopy(path.join(root, 'plugins'))).toThrow(/de\.json/);
  });
});

describe('withAndroidSheetCloseLabel', () => {
  it('writes the English value into the default strings.xml', async () => {
    const { resPath } = await runMod();
    const strings = readStrings(path.join(resPath, 'values', 'strings.xml'));
    const entry = strings.resources.string.find(item => item.$.name === RESOURCE_NAME);
    expect(entry?._).toBe('Close');
  });
  it('writes one locale folder per non-English language', async () => {
    const { resPath } = await runMod();
    expect(readStrings(path.join(resPath, 'values-b+pt+BR', LOCALE_FILE)).resources.string).toEqual(
      [{ $: { name: RESOURCE_NAME }, _: 'Fechar' }]
    );
    expect(readStrings(path.join(resPath, 'values-b+de', LOCALE_FILE)).resources.string).toEqual([
      { $: { name: RESOURCE_NAME }, _: 'Schließen' },
    ]);
    // A script-carrying tag uses the b+ qualifier too.
    expect(
      readStrings(path.join(resPath, 'values-b+zh+Hans', LOCALE_FILE)).resources.string
    ).toEqual([{ $: { name: RESOURCE_NAME }, _: '关闭' }]);
    // 87 catalogs minus English.
    const folders = fs
      .readdirSync(resPath)
      .filter(dir => dir.startsWith('values-b+'))
      .map(dir => fs.readFileSync(path.join(resPath, dir, LOCALE_FILE), 'utf8'));
    expect(folders).toHaveLength(86);
  });

  it('escapes XML-special values like any close copy', async () => {
    // No current catalog value needs escaping; prove the pipeline would not
    // emit raw XML by reusing the shared escaping helper on a hostile value.
    const { escapeValue } = require('./android-strings-helpers.js') as {
      escapeValue: (value: string) => string;
    };
    expect(escapeValue(`a&b<c>'d"e`)).toBe('a&amp;b&lt;c>\\\'d\\"e');
  });

  it('stays a registered plugin in app.config.ts', () => {
    // The committed plugin must remain wired into the Expo config for the
    // prebuild to generate the resources at all.
    const config = fs.readFileSync(path.join(PLUGINS_DIR, '..', 'app.config.ts'), 'utf8');
    expect(config).toMatch(/'\.\/plugins\/withAndroidSheetCloseLabel'/);
  });
});
