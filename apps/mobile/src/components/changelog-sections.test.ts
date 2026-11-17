import { describe, expect, it } from 'vitest';

import { changelogNotesArePending, changelogSections } from './changelog-sections';

const CHANGELOG = `# Kilo App Changelog

Newest first: one section per store build.

## 1.0.16 (build 720 iOS, 721 Android)

- feat(mobile)!: open the changelog natively ([#9947](https://github.com/Kilo-Org/cloud/pull/9947))
- chore(repo): remove a stale comment ([#9948](https://github.com/Kilo-Org/cloud/pull/9948))

## 1.0.15 (build 710 iOS, 711 Android)

- fix(auth): link same-email sign-ins ([#10334](https://github.com/Kilo-Org/cloud/pull/10334))
- bot: align the composer spacing (#9817)

## 1.0.15 (build 703 iOS, 704 Android)

- perf(mobile): cut foreground refetch bursts (#6640)
- (janitor/test-prune): remove tautological tests ([#9233](https://github.com/Kilo-Org/cloud/pull/9233))
- chore/remove autotriage code (#8151)
- docs(notifications): correct a comment ([#10130](https://github.com/Kilo-Org/cloud/pull/10130))
`;

describe('changelogSections', () => {
  it('returns each release as the reader sees it', () => {
    expect(changelogSections(CHANGELOG)).toEqual([
      { version: '1.0.16', notes: ['Open the changelog natively'] },
      {
        version: '1.0.15',
        notes: ['Link same-email sign-ins', 'Align the composer spacing'],
      },
      // The second 1.0.15 build continues the version the item above named, and
      // the maintenance bullets leave nothing to show for it beyond the note.
      { version: null, notes: ['Cut foreground refetch bursts'] },
    ]);
  });

  it('drops the document title and the maintainer note above the first release', () => {
    const notes = changelogSections(CHANGELOG).flatMap(section => section.notes);
    expect(notes.some(note => note.includes('Kilo App Changelog'))).toBe(false);
    expect(notes.some(note => note.includes('Newest first'))).toBe(false);
  });

  it('drops a section whose bullets are all internal work', () => {
    const internalOnly = `## 1.0.17 (build 730 iOS, 731 Android)

- docs(notifications): correct a comment
- test(mobile): pin the sheet height
- No user-visible changes since the previous build.
`;
    expect(changelogSections(internalOnly)).toEqual([]);
  });

  it('drops the initial-release note, which says no change shipped', () => {
    const initial = `## 1.0.1 (build 20 iOS, 21 Android)

- Initial release: no earlier build to compare against.
`;
    expect(changelogSections(initial)).toEqual([]);
  });

  it('names a version once across consecutive builds and again after another version', () => {
    const sections = changelogSections(
      `## 1.0.15 (build 710 iOS, 711 Android)

- fix(mobile): one

## 1.0.15 (build 703 iOS, 704 Android)

- fix(mobile): two

## 1.0.14 (build 700 iOS, 701 Android)

- fix(mobile): three
`
    );
    expect(sections.map(section => section.version)).toEqual(['1.0.15', null, '1.0.14']);
  });

  it('keeps a heading that names no version as its own title', () => {
    expect(changelogSections(`## Unreleased\n\n- fix(mobile): one\n`)).toEqual([
      { version: 'Unreleased', notes: ['One'] },
    ]);
  });

  it('returns nothing for a file with no release heading and an empty file', () => {
    expect(changelogSections('# Kilo App Changelog\n')).toEqual([]);
    expect(changelogSections('')).toEqual([]);
  });
});

describe('changelogNotesArePending', () => {
  it('reports notes that end before the installed version', () => {
    expect(changelogNotesArePending(CHANGELOG, '1.0.17')).toBe(true);
    expect(changelogNotesArePending(CHANGELOG, '1.1.0')).toBe(true);
  });

  it('says nothing when the newest section is the installed version', () => {
    expect(changelogNotesArePending(CHANGELOG, '1.0.16')).toBe(false);
  });

  it('says nothing when the bundle already carries a later version', () => {
    expect(changelogNotesArePending(CHANGELOG, '1.0.15')).toBe(false);
    expect(changelogNotesArePending(CHANGELOG, '0.9.99')).toBe(false);
  });

  it('reads the newest heading, not the first', () => {
    const outOfOrder = `## 1.0.14 (build 690 iOS, 691 Android)\n\n## 1.0.15 (build 710 iOS, 711 Android)\n`;
    expect(changelogNotesArePending(outOfOrder, '1.0.16')).toBe(true);
    expect(changelogNotesArePending(outOfOrder, '1.0.15')).toBe(false);
  });

  it('says nothing when a heading or the installed version does not parse', () => {
    expect(changelogNotesArePending('## Unreleased\n\n- something\n', '1.0.16')).toBe(false);
    expect(changelogNotesArePending('# Kilo App Changelog\n', '1.0.16')).toBe(false);
    expect(changelogNotesArePending('', '1.0.16')).toBe(false);
    expect(changelogNotesArePending(CHANGELOG, null)).toBe(false);
    expect(changelogNotesArePending(CHANGELOG, '1.0')).toBe(false);
  });
});
