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

/**
 * The two keys that are the in-app instruction for connecting a computer: they
 * name the command the user runs there, so the command text must stay.
 */
const COMMAND_COPY_KEYS: string[][] = [
  ['agentChat', 'instancePicker', 'noCliInstancesDescription'],
  ['tour', 'remoteOptionBody'],
];

/** Jargon the Run on helper sentence must not put in front of the reader. */
const CLI_JARGON = ['kilo remote', '/remote', 'CLI session', 'local kilo process'];

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
  it('keeps the English new-session hint in plain mobile language', () => {
    const value = valueAt(CATALOG_LOADERS.en(), ['agentChat', 'newSession', 'remoteHint']);
    expect(typeof value).toBe('string');

    // The phone user reads one actionable sentence telling them to start Kilo
    // on their computer; no CLI-only entry point, no internal vocabulary.
    expect(value).toBe('To run on your computer, start Kilo there and leave it running.');
    expect(value as string).not.toContain('/remote');
    expect(value as string).not.toContain('CLI session');
    expect(value as string).not.toContain('local kilo process');
    expect(value as string).not.toContain('`');
  });

  // The translated catalogs still carry the reviewed wording — the translation
  // pipeline owns them, so this PR only changed `en.json`. Whatever markers a
  // catalog holds, the renderer strips them before the reader sees the text.
  it.each(SUPPORTED_LANGUAGES)('%s never renders an authoring marker', tag => {
    const catalog = CATALOG_LOADERS[tag]();

    for (const path of RUN_LOCATION_COPY_KEYS) {
      const value = valueAt(catalog, path);
      expect(typeof value, `${tag} ${path.join('.')}`).toBe('string');
      const visible = stripInlineCodeMarkers(value as string);
      expect(visible, `${tag} ${path.join('.')}`).not.toContain('`');
    }
  });

  it.each(SUPPORTED_LANGUAGES)('%s keeps the command text the two command keys need', tag => {
    const catalog = CATALOG_LOADERS[tag]();

    for (const path of COMMAND_COPY_KEYS) {
      const value = valueAt(catalog, path);
      expect(typeof value, `${tag} ${path.join('.')}`).toBe('string');
      const visible = stripInlineCodeMarkers(value as string);
      expect(visible, `${tag} ${path.join('.')}`).toContain('kilo remote');
    }
  });

  it('the English Run on helper sentence names no command or CLI jargon', () => {
    const catalog = CATALOG_LOADERS.en();
    const path = ['agentChat', 'newSession', 'remoteHint'];
    const value = valueAt(catalog, path);

    expect(typeof value, path.join('.')).toBe('string');
    // The catalog is the source: it must ship without authoring markers.
    expect(value as string, path.join('.')).not.toContain('`');
    const visible = stripInlineCodeMarkers(value as string);
    for (const term of CLI_JARGON) {
      expect(visible, `${path.join('.')} contains ${term}`).not.toContain(term);
    }
    expect(visible).toBe('To run on your computer, start Kilo there and leave it running.');
  });
});
