import { describe, expect, it } from 'vitest';

import { CATALOG_LOADERS } from './catalogs';
import { SUPPORTED_LANGUAGES } from './languages';
import { stripInlineCodeMarkers } from './plain-copy';

/**
 * The run-location help the new-task screen, the tour's fork card and the
 * instance picker show. Every catalog used to wrap `kilo remote` and `/remote`
 * in backticks, and the native `Text` drew the punctuation.
 */
const RUN_LOCATION_COPY_KEYS: string[][] = [
  ['agentChat', 'newSession', 'remoteHint'],
  ['agentChat', 'instancePicker', 'noCliInstancesDescription'],
  ['tour', 'remoteOptionBody'],
];

function valueAt(catalog: unknown, path: string[]): unknown {
  let node: unknown = catalog;
  for (const key of path) {
    node = (node as Record<string, unknown> | undefined)?.[key];
  }
  return node;
}

describe('stripInlineCodeMarkers', () => {
  it('drops the backticks and keeps the command text', () => {
    expect(stripInlineCodeMarkers('Run `kilo remote`, or `/remote` in a CLI session.')).toBe(
      'Run kilo remote, or /remote in a CLI session.'
    );
  });

  it('leaves copy without markers unchanged', () => {
    expect(stripInlineCodeMarkers('Run kilo remote on your computer.')).toBe(
      'Run kilo remote on your computer.'
    );
  });
});

describe('run-location help copy', () => {
  it.each(SUPPORTED_LANGUAGES)('%s never renders an authoring marker', tag => {
    const catalog = CATALOG_LOADERS[tag]();

    for (const path of RUN_LOCATION_COPY_KEYS) {
      const value = valueAt(catalog, path);
      expect(typeof value, `${tag} ${path.join('.')}`).toBe('string');
      const visible = stripInlineCodeMarkers(value as string);
      expect(visible, `${tag} ${path.join('.')}`).not.toContain('`');
      expect(visible, `${tag} ${path.join('.')}`).toContain('kilo remote');
    }
  });
});
