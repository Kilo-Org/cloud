import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { RTL_LANGUAGES } from './languages';

/** Every catalog value that embeds an ASCII command in right-to-left prose. */
const COMMAND_COPY_KEYS: string[][] = [
  ['nativeRemote', 'prompt'],
  ['nativeRemote', 'unsafeCommand'],
  ['agentChat', 'slashCommands', 'goalDescription'],
];

const LTR_ISOLATE_OPEN = '\u2066';
const LTR_ISOLATE_CLOSE = '\u2069';
/** One slash command: a slash, a word, and an optional bracketed argument. */
const COMMAND_RUN = /\/[A-Za-z][A-Za-z-]*/gu;

function valueAt(catalog: unknown, path: string[]): unknown {
  let node: unknown = catalog;
  for (const key of path) {
    node = (node as Record<string, unknown> | undefined)?.[key];
  }
  return node;
}

/**
 * The commands a right-to-left paragraph would reorder: a run whose nearest
 * preceding isolate mark is the close mark, or which sits in no isolate at all.
 */
function unisolatedCommands(value: string): string[] {
  const found: string[] = [];
  for (const match of value.matchAll(COMMAND_RUN)) {
    const before = value.slice(0, match.index);
    if (before.lastIndexOf(LTR_ISOLATE_OPEN) <= before.lastIndexOf(LTR_ISOLATE_CLOSE)) {
      found.push(match[0]);
    }
  }
  return found;
}

const RTL_TAGS = [...RTL_LANGUAGES];

describe('right-to-left command copy', () => {
  it.each(RTL_TAGS)('%s isolates every command run', tag => {
    const catalog = CATALOG_LOADERS[tag]();

    for (const path of COMMAND_COPY_KEYS) {
      const label = `${tag} ${path.join('.')}`;
      const value = valueAt(catalog, path);
      expect(typeof value, label).toBe('string');

      const source = value as string;
      expect(unisolatedCommands(source), label).toEqual([]);
      // A run is isolated or it is not: every open mark has its close mark.
      expect((source.match(/\u2066/gu) ?? []).length, label).toBe(
        (source.match(/\u2069/gu) ?? []).length
      );
      expect(source.match(COMMAND_RUN) ?? [], label).not.toEqual([]);
    }
  });

  it('leaves the English source copy plain', () => {
    const catalog = CATALOG_LOADERS.en();

    for (const path of COMMAND_COPY_KEYS) {
      const value = valueAt(catalog, path);
      expect(typeof value, path.join('.')).toBe('string');
      expect(value as string, path.join('.')).not.toMatch(/[\u2066\u2069]/u);
    }
  });
});
