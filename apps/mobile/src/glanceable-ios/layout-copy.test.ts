/* eslint-disable eslint-plugin-import/no-nodejs-modules, eslint-plugin-unicorn/prefer-module -- this test reads the layout sources from disk, which is the only place the placeholder is observable */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { glanceableLayoutCopy, withGlanceableCopy } from './layout-copy';

const PLACEHOLDER = '__KILO_GLANCEABLE_COPY__';
const LAYOUT_FILES = ['active-agents-live-activity.tsx', 'active-agents-widget.tsx'];

const read = (file: string) => readFileSync(join(__dirname, file), 'utf8');

/** Stands in for an untransformed layout, which is a function, not a string. */
const untransformedLayout = () => null;

/**
 * The `'widget'` layouts are stringified by Babel and re-evaluated inside the
 * widget process, where an imported binding is an undefined global that throws
 * and blanks the whole surface. So the placeholder must appear as a literal in
 * each layout source. These assertions read the sources because no widget
 * transform runs under vitest.
 */
describe('glanceable layout copy placeholder', () => {
  it('matches the token layout-copy.ts replaces', () => {
    expect(read('layout-copy.ts')).toContain(`= '${PLACEHOLDER}'`);
  });

  for (const file of LAYOUT_FILES) {
    it(`is a literal in ${file}`, () => {
      expect(read(file)).toContain(`= '${PLACEHOLDER}'`);
    });
  }
});

describe('withGlanceableCopy', () => {
  it('leaves the untransformed function alone', () => {
    expect(withGlanceableCopy(untransformedLayout)).toBe(untransformedLayout);
  });

  it('replaces the quoted token with a JSON source literal the layout can parse', () => {
    const prefix = 'const copySource = ';
    const source = withGlanceableCopy(`${prefix}'${PLACEHOLDER}';`);
    expect(source).not.toContain(PLACEHOLDER);
    // The patched text must be a valid source literal, so copy that contains an
    // apostrophe ("Can't update now") cannot break the layout the widget
    // process evaluates. A JSON string literal is also valid JSON, so parsing
    // twice reads the copy back the way the layout's `JSON.parse` does.
    const literal = source.slice(prefix.length, -1);
    expect(JSON.parse(JSON.parse(literal) as string)).toEqual(glanceableLayoutCopy());
  });

  it('bakes no digit table for a language that writes the plain ten', () => {
    // English is `latn`, so the layout's own `String` is already right and the
    // empty table tells it to skip the mapping.
    expect(glanceableLayoutCopy().digits).toBe('');
  });

  it('bakes the locale in the form the SwiftUI modifier accepts', () => {
    // `@expo/ui` applies the locale only when `Locale.availableIdentifiers`
    // contains the value, and that list writes `zh_Hans`, not `zh-Hans`. A
    // hyphen there silently left the wait in the device language.
    expect(glanceableLayoutCopy().locale).not.toContain('-');
  });

  it('covers every status the layouts render, plus the language tag', () => {
    expect(Object.keys(glanceableLayoutCopy()).toSorted()).toEqual([
      'digits',
      'empty',
      'expired',
      'idle',
      'locale',
      'needsInput',
      'openAgents',
      'privacy',
      'running',
      'signed_out',
      'stale',
      'waiting',
    ]);
  });
});
