import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseJournal } from '../../src/journal';

const fixtures = join(import.meta.dirname, '../fixtures');
/** origin/main's journal and migration file names, copied 2026-11-27 (c4e5c74b9e). */
const MAIN_JOURNAL = readFileSync(join(fixtures, 'main-journal.json'), 'utf8');
const MAIN_FILES = new Set(
  readFileSync(join(fixtures, 'main-migration-files.txt'), 'utf8').split('\n').filter(Boolean)
);

type Entry = { idx: number; version: string; when: number; tag: string; breakpoints: boolean };
const mainEntries = () => (JSON.parse(MAIN_JOURNAL) as { entries: Entry[] }).entries;
const journalOf = (entries: Entry[]) =>
  JSON.stringify({ version: '7', dialect: 'postgresql', entries });

describe('parseJournal', () => {
  it("accepts main's journal, whose when falls at 0034 -> 0035", () => {
    const parsed = parseJournal(MAIN_JOURNAL, MAIN_FILES);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.entries).toHaveLength(387);
    const at = (tag: string) => parsed.entries.find(entry => entry.tag.startsWith(tag))?.when ?? 0;
    expect(at('0034_')).toBeGreaterThan(at('0035_'));
    expect(parsed.entries.some(entry => entry.tag === '0075_account-deletion-requested-at')).toBe(
      true
    );
  });

  it('refuses a duplicate when', () => {
    const entries = mainEntries();
    entries[5] = { ...entries[5], when: entries[4].when };
    expect(parseJournal(journalOf(entries), MAIN_FILES)).toMatchObject({ ok: false });
  });

  it('refuses a duplicate tag', () => {
    const entries = mainEntries();
    entries[5] = { ...entries[5], tag: entries[4].tag };
    expect(parseJournal(journalOf(entries), MAIN_FILES)).toMatchObject({ ok: false });
  });

  it.each(['0001_Upper', '1_short', '0001_semi;colon', '0001_../escape', '00001_five'])(
    'refuses the tag %s',
    tag => {
      const entries = mainEntries();
      entries[1] = { ...entries[1], tag };
      expect(
        parseJournal(journalOf(entries), new Set([...MAIN_FILES, `${tag}.sql`]))
      ).toMatchObject({
        ok: false,
      });
    }
  );

  it('refuses a tag without its file', () => {
    const files = new Set(MAIN_FILES);
    files.delete(`${mainEntries()[10].tag}.sql`);
    expect(parseJournal(MAIN_JOURNAL, files)).toMatchObject({ ok: false });
  });

  it('refuses an idx out of position, another dialect, and non-JSON', () => {
    const entries = mainEntries();
    entries[3] = { ...entries[3], idx: 4 };
    expect(parseJournal(journalOf(entries), MAIN_FILES)).toMatchObject({ ok: false });
    expect(
      parseJournal(JSON.stringify({ dialect: 'sqlite', entries: mainEntries() }), MAIN_FILES)
    ).toMatchObject({ ok: false });
    expect(parseJournal('{', MAIN_FILES)).toMatchObject({ ok: false });
  });
});
