import { describe, expect, it } from 'vitest';

import { changelogNotesArePending, changelogSections } from './changelog-sections';

const LINK = 'https://github.com/Kilo-Org/cloud/pull';

const CHANGELOG = `# Kilo App Changelog

Newest first: one section per store build.

## 1.0.16 (build 720 iOS, 721 Android)

- feat(mobile)!: open the changelog natively ([#9947](${LINK}/9947))
- chore(repo): remove a stale comment ([#9948](${LINK}/9948))

## 1.0.15 (build 710 iOS, 711 Android)

- fix(auth): link same-email sign-ins ([#10334](${LINK}/10334))
- bot: align the composer spacing (#9817)

## 1.0.15 (build 703 iOS, 704 Android)

- perf(mobile): cut foreground refetch bursts (#6640)
- (janitor/test-prune): remove tautological tests (#9233)
- chore/remove autotriage code (#8151)
- docs(notifications): correct a comment (#10130)
`;

describe('changelogSections', () => {
  it('returns each release as the reader sees it', () => {
    expect(changelogSections(CHANGELOG)).toEqual([
      {
        version: '1.0.16',
        newNotes: ['Open the changelog natively'],
        fixesAreas: [],
        hasFixes: false,
      },
      // Both 1.0.15 builds are one release. Its repairs name one area — `auth`
      // maps to Sign-in — and the `bot`/`perf` bullets add none.
      { version: '1.0.15', newNotes: [], fixesAreas: ['signIn'], hasFixes: true },
    ]);
  });

  it('drops the document title and the maintainer note above the first release', () => {
    const texts = changelogSections(CHANGELOG).flatMap(section => section.newNotes);
    expect(texts.some(note => note.includes('Kilo App Changelog'))).toBe(false);
    expect(texts.some(note => note.includes('Newest first'))).toBe(false);
  });

  it('drops a version whose bullets are all internal work', () => {
    const internalOnly = `## 1.0.17 (build 730 iOS, 731 Android)

- docs(notifications): correct a comment
- test(mobile): pin the sheet height
- No user-visible changes since the previous build.
`;
    expect(changelogSections(internalOnly)).toEqual([]);
    expect(
      changelogSections(`## 1.0.1 (build 20 iOS, 21 Android)

- Initial release: no earlier build to compare against.
`)
    ).toEqual([]);
  });

  it('merges consecutive builds of one version into one release', () => {
    const sections = changelogSections(`## 1.0.15 (build 710 iOS, 711 Android)

- feat(chat): one

## 1.0.15 (build 703 iOS, 704 Android)

- feat(chat): two

## 1.0.14 (build 700 iOS, 701 Android)

- fix(auth): three
`);
    expect(sections.map(section => section.version)).toEqual(['1.0.15', '1.0.14']);
    expect(sections[0]?.newNotes).toEqual(['Two', 'One']);
    expect(sections[1]).toEqual({
      version: '1.0.14',
      newNotes: [],
      fixesAreas: ['signIn'],
      hasFixes: true,
    });
  });

  it('names the areas the fixes touched, in the map’s order', () => {
    const fixes = `## 1.0.15 (build 710 iOS, 711 Android)

- fix(notifications): lead with the message
- fix(auth): link same-email sign-ins
- fix(security-agent): name the scope
- fix(chat): keep the composer visible
- fix(session): keep the transcript in order
- fix(mobile): correct the Igbo code reviewer copy
`;
    expect(changelogSections(fixes)).toEqual([
      {
        version: '1.0.15',
        newNotes: [],
        // Canonical order, not the order the bullets name them.
        fixesAreas: ['chat', 'cloudAgent', 'securityAgent', 'signIn', 'notifications'],
        hasFixes: true,
      },
    ]);
  });

  it('lists the newest six features, newest first', () => {
    const features = [1, 2, 3, 4, 5, 6, 7]
      .map(index => `- feat(chat): feature ${index}`)
      .join('\n');
    expect(changelogSections(`## 1.0.15 (build 710)\n\n${features}\n`)[0]?.newNotes).toEqual([
      'Feature 7',
      'Feature 6',
      'Feature 5',
      'Feature 4',
      'Feature 3',
      'Feature 2',
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
- feat(chat): keep the composer visible
`;
    expect(changelogSections(plumbing)).toEqual([
      {
        version: '1.0.15',
        newNotes: ['Keep the composer visible'],
        fixesAreas: [],
        hasFixes: false,
      },
    ]);
  });

  it('reads the curated sections the Release workflow composes', () => {
    const curated = `## 1.0.16 (build 720 iOS, 721 Android)

### New

- Open the changelog natively
- Keep the composer visible

### Fixes

- areas: chat, signIn
`;
    expect(changelogSections(curated)).toEqual([
      {
        version: '1.0.16',
        newNotes: ['Open the changelog natively', 'Keep the composer visible'],
        fixesAreas: ['chat', 'signIn'],
        hasFixes: true,
      },
    ]);
  });

  it('keeps a heading that names no version as its own title', () => {
    expect(changelogSections(`## Unreleased\n\n- feat(chat): one\n`)).toEqual([
      { version: 'Unreleased', newNotes: ['One'], fixesAreas: [], hasFixes: false },
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
