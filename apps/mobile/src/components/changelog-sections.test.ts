import { describe, expect, it } from 'vitest';

import { changelogNotesArePending, splitChangelogSections } from './changelog-sections';

const CHANGELOG = `# Kilo App Changelog

Newest first: one section per store build.

## 1.0.16 (build 720 iOS, 721 Android)

- fix(mobile): open the changelog natively

## 1.0.15 (build 710 iOS, 711 Android)

- feat(auth): link same-email sign-ins
`;

describe('splitChangelogSections', () => {
  it('returns only the release sections, in file order', () => {
    expect(splitChangelogSections(CHANGELOG)).toEqual([
      '## 1.0.16 (build 720 iOS, 721 Android)\n\n- fix(mobile): open the changelog natively\n\n',
      '## 1.0.15 (build 710 iOS, 711 Android)\n\n- feat(auth): link same-email sign-ins\n',
    ]);
  });

  it('drops the preamble above the first release heading', () => {
    const chunks = splitChangelogSections(CHANGELOG);
    expect(chunks.some(chunk => chunk.startsWith('# Kilo'))).toBe(false);
  });

  it('keeps every byte from the first release heading onward', () => {
    const releaseSections = CHANGELOG.slice(CHANGELOG.indexOf('\n## ') + 1);
    expect(splitChangelogSections(CHANGELOG).join('')).toBe(releaseSections);
  });

  it('returns nothing for a file with no release heading and an empty file', () => {
    expect(splitChangelogSections('# Kilo App Changelog\n')).toEqual([]);
    expect(splitChangelogSections('')).toEqual([]);
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
