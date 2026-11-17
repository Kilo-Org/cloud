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
      { version: '1.0.16', notes: ['Open the changelog natively'], translationLanguages: [] },
      {
        version: '1.0.15',
        notes: [
          'Link same-email sign-ins',
          'Align the composer spacing',
          'Cut foreground refetch bursts',
        ],
        translationLanguages: [],
      },
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

  it('merges consecutive builds of one version into one list under one heading', () => {
    const sections = changelogSections(
      `## 1.0.15 (build 710 iOS, 711 Android)

- fix(mobile): one

## 1.0.15 (build 703 iOS, 704 Android)

- fix(mobile): two

## 1.0.14 (build 700 iOS, 701 Android)

- fix(mobile): three
`
    );
    expect(sections.map(section => section.version)).toEqual(['1.0.15', '1.0.14']);
    expect(sections[0]?.notes).toEqual(['One', 'Two']);
  });

  it('keeps a heading that names no version as its own title', () => {
    expect(changelogSections(`## Unreleased\n\n- fix(mobile): one\n`)).toEqual([
      { version: 'Unreleased', notes: ['One'], translationLanguages: [] },
    ]);
  });

  it('folds a version’s catalog fixes into the languages they corrected', () => {
    const sections = changelogSections(
      `## 1.0.15 (build 710 iOS, 711 Android)

- fix(mobile): correct the Igbo code reviewer copy
- fix(mobile): use one Estonian term for pull request
- fix(mobile): align the Igbo session badge and failure copy
- fix(mobile): keep the composer visible

## 1.0.15 (build 703 iOS, 704 Android)

- fix(mobile): correct Armenian agent chat copy
`
    );
    expect(sections).toEqual([
      {
        version: '1.0.15',
        notes: ['Keep the composer visible'],
        translationLanguages: ['Igbo', 'Estonian', 'Armenian'],
      },
    ]);
  });

  it('drops work a reader cannot see even when its commit type ships changes', () => {
    const plumbing = `## 1.0.15 (build 710 iOS, 711 Android)

- feat(mobile): add flag-gated native remote demo
- feat(mobile): add shared client transport and web demo
- fix(mobile): bound native sync recovery by socket generation
- fix(mobile): align Spend alerts card padding with the info card
- fix(mobile): drop the redundant Members section label
- fix(mobile): answer the request a glanceable approval names
- fix(mobile): keep the composer visible
`;
    expect(changelogSections(plumbing)).toEqual([
      { version: '1.0.15', notes: ['Keep the composer visible'], translationLanguages: [] },
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

  it('says nothing when a version cannot be read', () => {
    expect(changelogNotesArePending(CHANGELOG, null)).toBe(false);
    expect(changelogNotesArePending(CHANGELOG, 'nightly')).toBe(false);
    expect(changelogNotesArePending('# no headings\n', '1.0.16')).toBe(false);
  });
});
