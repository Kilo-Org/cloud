import { describe, expect, it } from 'vitest';

import en from './locales/en.json';

/**
 * Catalog copy reaches the screen through `InlineCodeText`, which draws a
 * backticked run in the mono style and leaves everything else as body copy. A
 * value that is not rendered through it would show the marker itself, so only
 * the two keys that name the `kilo remote` command carry backticks in English,
 * and they mark the command once.
 */
const COMMAND_COPY = [
  {
    key: 'agentChat.instancePicker.noCliInstancesDescription',
    value:
      'Run `kilo remote` in a project on your computer, or update Kilo CLI if one is already running.',
  },
  {
    key: 'tour.remoteOptionBody',
    value: 'Run Kilo on your own machine through the `kilo remote` CLI.',
  },
] as const;

const COMMAND_KEY_PATHS = new Set<string>(COMMAND_COPY.map(entry => entry.key));

const REMOTE_HINT = {
  key: 'agentChat.newSession.remoteHint',
  value: 'To run on your computer, start Kilo there and leave it running.',
} as const;

function lookup(path: string): unknown {
  let node: unknown = en;
  for (const part of path.split('.')) {
    if (!node || typeof node !== 'object' || !(part in node)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return node;
}

describe('plain-text copy', () => {
  it.each(COMMAND_COPY)('marks the command once in $key', ({ key, value }) => {
    expect(lookup(key)).toBe(value);
    expect(value.match(/`[^`]*`/g)).toStrictEqual(['`kilo remote`']);
  });

  it('keeps the computer hint free of command markers', () => {
    expect(lookup(REMOTE_HINT.key)).toBe(REMOTE_HINT.value);
  });

  it('carries a marker nowhere else in the English catalog', () => {
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        if (node.includes('`') && !COMMAND_KEY_PATHS.has(path)) {
          offenders.push(`${path}: ${node}`);
        }
        return;
      }
      if (node && typeof node === 'object') {
        for (const [key, child] of Object.entries(node)) {
          walk(child, path ? `${path}.${key}` : key);
        }
      }
    };

    walk(en, '');

    expect(offenders).toEqual([]);
  });
});
