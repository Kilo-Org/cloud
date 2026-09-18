/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the Swift intent and the app catalogs from disk, which is the only place the untranslated literals are observable */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import copy from '../../plugins/focus-filter-copy.json';
import {
  buildFocusFilterLocales,
  buildFocusFilterStringsFiles,
  FOCUS_FILTER_STRINGS,
  type FocusFilterCopy,
} from './focus-filter-locales';
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from './languages';

const locales = buildFocusFilterLocales(copy);
const files = buildFocusFilterStringsFiles(copy);
const STRING_NAMES = Object.keys(FOCUS_FILTER_STRINGS) as (keyof typeof FOCUS_FILTER_STRINGS)[];

const read = (relative: string) => readFileSync(join(__dirname, relative), 'utf8');

const stringsFor = (tag: SupportedLanguage) => locales[tag].ios['Localizable.strings'];
const linesFor = (tag: SupportedLanguage) => files[tag].trimEnd().split('\n');

/** The lookup key of one emitted `.strings` entry; it must be quoted. */
function entryKey(line: string): string {
  const key = /^"(?<key>(?:[^"\\]|\\.)*)" = /.exec(line)?.groups?.key;
  if (!key) {
    throw new Error(`No quoted key in the emitted entry: ${line}`);
  }
  return key;
}

const keysFor = (tag: SupportedLanguage) => linesFor(tag).map(line => entryKey(line));

const swift = read('../../modules/notification-focus-filter/ios/AgentProgressFocusFilter.swift');

/** The literal a Swift initializer carries; it is the catalog lookup key. */
function swiftLiteral(pattern: RegExp): string {
  const match = swift.match(pattern);
  if (!match?.[1]) {
    throw new Error(`No string literal for ${pattern} in AgentProgressFocusFilter.swift`);
  }
  return match[1];
}

describe('buildFocusFilterStringsFiles', () => {
  it('covers exactly the supported languages', () => {
    expect(Object.keys(files).toSorted()).toEqual(SUPPORTED_LANGUAGES.toSorted());
  });

  it.each(SUPPORTED_LANGUAGES)('fills all three strings in %s', tag => {
    for (const name of STRING_NAMES) {
      const value = stringsFor(tag)[FOCUS_FILTER_STRINGS[name]];
      expect(value?.trim().length ?? 0, `${tag}.${name}`).toBeGreaterThan(0);
    }
    expect(linesFor(tag)).toHaveLength(STRING_NAMES.length);
  });

  // The defect this writer exists for: Expo's `withLocales` emits a bare key
  // (`Agent notifications = "…";`), which the Xcode CopyStringsFile step cannot
  // parse, so no Focus-filter string resolves and the control stays English on a
  // localized device. Every emitted entry must therefore be a quoted key.
  it.each(SUPPORTED_LANGUAGES)('quotes every emitted key in %s', tag => {
    for (const line of linesFor(tag)) {
      expect(line, `${tag}: ${line}`).toMatch(/^"(?:[^"\\]|\\.)*" = "(?:[^"\\]|\\.)*";$/);
    }
    expect(files[tag].endsWith('\n'), `${tag} ends the file with a newline`).toBe(true);
  });

  it('keys the catalog by the literals the Swift intent declares', () => {
    const title = swiftLiteral(/static var title: LocalizedStringResource = "([^"]*)"/);
    const description = swiftLiteral(/IntentDescription\(\s*"([^"]*)"/);
    const agentProgress = swiftLiteral(/@Parameter\(title: "([^"]*)"\)/);
    // `DisplayRepresentation` repeats the title, so it resolves to the same entry.
    expect(swiftLiteral(/DisplayRepresentation\(title: "([^"]*)"\)/)).toBe(title);
    for (const tag of SUPPORTED_LANGUAGES) {
      expect(keysFor(tag), tag).toEqual([title, description, agentProgress]);
    }
  });

  it('ships the English literals unchanged', () => {
    expect(stringsFor('en')).toEqual({
      [FOCUS_FILTER_STRINGS.title]: FOCUS_FILTER_STRINGS.title,
      [FOCUS_FILTER_STRINGS.description]: FOCUS_FILTER_STRINGS.description,
      [FOCUS_FILTER_STRINGS.agentProgress]: FOCUS_FILTER_STRINGS.agentProgress,
    });
  });

  it('escapes a quote or a backslash in an emitted value', () => {
    const escaped = buildFocusFilterStringsFiles({
      ...copy,
      de: { ...copy.de, title: 'Kilo "Kilo"', description: 'back\\slash' },
    });
    const [title, description] = escaped.de.split('\n');
    expect(title).toBe(String.raw`"Agent notifications" = "Kilo \"Kilo\"";`);
    expect(description).toBe(
      String.raw`"Keep notifications that need your input and silence agent progress for this Focus." = "back\\slash";`
    );
  });

  // The parameter label and the Android channel name are the same choice, so a
  // catalog edit on either side must not let them drift apart.
  it.each(SUPPORTED_LANGUAGES)('labels the parameter with the %s channel name', tag => {
    const catalog = JSON.parse(read(`locales/${tag}.json`)) as {
      notifications: { channel: { agentProgress: string } };
    };
    expect(stringsFor(tag)[FOCUS_FILTER_STRINGS.agentProgress]).toBe(
      catalog.notifications.channel.agentProgress
    );
  });

  it('throws when a supported language has no copy', () => {
    const { de: _de, ...rest } = copy;
    const incomplete: FocusFilterCopy = rest;
    expect(() => buildFocusFilterStringsFiles(incomplete)).toThrow(
      'Missing Focus-filter copy for language: de'
    );
  });

  it('throws when any string is empty', () => {
    const incomplete: FocusFilterCopy = {
      ...copy,
      de: { ...copy.de, agentProgress: '   ' },
    };
    expect(() => buildFocusFilterStringsFiles(incomplete)).toThrow(
      'Missing or empty Focus-filter copy for de.agentProgress'
    );
  });
});
