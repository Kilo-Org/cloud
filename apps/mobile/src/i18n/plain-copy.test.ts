import { describe, expect, it } from 'vitest';

import { LTR_ISOLATE_CLOSE, LTR_ISOLATE_OPEN } from '@/lib/bidi';

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

function valueAt(catalog: unknown, path: string[]): unknown {
  let node: unknown = catalog;
  for (const key of path) {
    node = (node as Record<string, unknown> | undefined)?.[key];
  }
  return node;
}

/** The command as the reader gets it: one isolated, unbreakable left-to-right run. */
const ISOLATED_COMMAND = `${LTR_ISOLATE_OPEN}kilo\u00A0remote${LTR_ISOLATE_CLOSE}`;

describe('stripInlineCodeMarkers', () => {
  it('renders a marked run as one isolated left-to-right run', () => {
    expect(stripInlineCodeMarkers('Run `kilo remote`, or `/remote` in a CLI session.')).toBe(
      `Run ${ISOLATED_COMMAND}, or ${LTR_ISOLATE_OPEN}/remote${LTR_ISOLATE_CLOSE} in a CLI session.`
    );
  });

  it('leaves no breakable space inside the run', () => {
    // A breakable space let a wrapped right-to-left sentence split the command
    // across two lines, which then read as two fragments. The isolate alone is
    // zero-width; the no-break space is what keeps the command on one line.
    const visible = stripInlineCodeMarkers('Run `kilo remote` on your computer.');
    const inside = visible.slice(
      visible.indexOf(LTR_ISOLATE_OPEN) + 1,
      visible.indexOf(LTR_ISOLATE_CLOSE)
    );

    expect(inside).toBe('kilo\u00A0remote');
    expect(inside).not.toContain(' ');
  });

  it('leaves the sentence period outside the isolate', () => {
    // A right-to-left sentence that ends with the command and then its period,
    // as the tour card does. The period belongs to the sentence, not to the
    // run: inside the isolate it would be ordered as left-to-right text and
    // land on the wrong side. The wording is a fixture, not the shipped
    // translation, so a reworded catalog cannot break the rendering contract.
    const source = 'شغّل Kilo على جهازك نفسه عبر واجهة سطر الأوامر `kilo remote`.';

    const visible = stripInlineCodeMarkers(source);
    expect(visible).toBe(`شغّل Kilo على جهازك نفسه عبر واجهة سطر الأوامر ${ISOLATED_COMMAND}.`);
    expect(visible.endsWith(`${LTR_ISOLATE_CLOSE}.`)).toBe(true);
  });

  it('leaves copy without markers unchanged', () => {
    expect(stripInlineCodeMarkers('Run kilo remote on your computer.')).toBe(
      'Run kilo remote on your computer.'
    );
  });

  it('drops a lone authoring marker', () => {
    expect(stripInlineCodeMarkers('Run kilo remote`.')).toBe('Run kilo remote.');
  });
});

describe('run-location help copy', () => {
  it('keeps the English new-session hint in plain mobile language', () => {
    const value = valueAt(CATALOG_LOADERS.en(), ['agentChat', 'newSession', 'remoteHint']);
    expect(typeof value).toBe('string');

    // The phone user reads one actionable sentence telling them to start Kilo
    // on their computer; no CLI-only entry point, no internal vocabulary.
    expect(value).toBe('To run on your computer, start Kilo there and leave it running.');
    // The catalog ships without authoring markers, so the renderer changes nothing.
    expect(stripInlineCodeMarkers(value as string)).toBe(value);
  });

  // The translated catalogs still carry the reviewed wording — the translation
  // pipeline owns them, so only `en.json` lost its markers. Whatever markers a
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
      // The run's own space is a no-break space, so compare with spaces.
      expect(visible.replaceAll('\u00A0', ' '), `${tag} ${path.join('.')}`).toContain(
        'kilo remote'
      );
    }
  });

  // Every wording that embeds the command gets the same treatment: the run is
  // one isolate with no breakable space inside, and no part of it sits outside.
  // A catalog that ships the command plain (English) keeps its copy as it is.
  it.each(SUPPORTED_LANGUAGES)('%s isolates every marked command run', tag => {
    const catalog = CATALOG_LOADERS[tag]();

    for (const path of COMMAND_COPY_KEYS) {
      const label = `${tag} ${path.join('.')}`;
      const value = valueAt(catalog, path);
      expect(typeof value, label).toBe('string');

      const source = value as string;
      const visible = stripInlineCodeMarkers(source);
      const marked = (source.match(/`[^`]*`/g) ?? []).length;
      expect(visible.split(ISOLATED_COMMAND).length - 1, label).toBe(marked);
      // The treatment adds marks and unbreakable spaces only: no command text
      // is lost or duplicated.
      expect(visible.replaceAll(ISOLATED_COMMAND, 'kilo remote'), label).toBe(
        source.replaceAll('`', '')
      );
    }
  });
});
