import { describe, expect, it } from 'vitest';

import en from './locales/en.json';

/**
 * Catalog copy reaches the screen through plain `<Text>` (or the mono variant):
 * the app has no inline-markdown renderer, so a markdown backtick in a value is
 * shown to the reader literally. The new-session composer's "Run on" helper
 * rendered the raw `` `kilo remote` `` / `` `/remote` `` backticks, so English —
 * the source of truth for the other catalogs — must stay free of them.
 */
const RUN_COPY = [
  {
    key: 'agentChat.newSession.remoteHint',
    value: 'To run on your computer, start Kilo there and leave it running.',
  },
  {
    key: 'agentChat.instancePicker.noCliInstancesDescription',
    value:
      'Run kilo remote in a project on your computer, or update Kilo CLI if one is already running.',
  },
  {
    key: 'tour.remoteOptionBody',
    value: 'Run Kilo on your own machine through the kilo remote CLI.',
  },
] as const;

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
  it.each(RUN_COPY)('keeps $key free of markdown backticks', ({ key, value }) => {
    expect(lookup(key)).toBe(value);
    expect(value).not.toContain('`');
  });

  it('has no markdown backticks anywhere in the English catalog', () => {
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (typeof node === 'string') {
        if (node.includes('`')) {
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
