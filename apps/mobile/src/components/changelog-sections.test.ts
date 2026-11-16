import { describe, expect, it } from 'vitest';

import { splitChangelogSections } from './changelog-sections';

const CHANGELOG = `# Kilo App Changelog

Newest first: one section per store build.

## 1.0.16 (build 720 iOS, 721 Android)

- fix(mobile): open the changelog natively

## 1.0.15 (build 710 iOS, 711 Android)

- feat(auth): link same-email sign-ins
`;

describe('splitChangelogSections', () => {
  it('starts a chunk at every release heading', () => {
    expect(splitChangelogSections(CHANGELOG)).toEqual([
      '# Kilo App Changelog\n\nNewest first: one section per store build.\n\n',
      '## 1.0.16 (build 720 iOS, 721 Android)\n\n- fix(mobile): open the changelog natively\n\n',
      '## 1.0.15 (build 710 iOS, 711 Android)\n\n- feat(auth): link same-email sign-ins\n',
    ]);
  });

  it('keeps every byte of the source', () => {
    expect(splitChangelogSections(CHANGELOG).join('')).toBe(CHANGELOG);
  });

  it('handles a file with no release heading and an empty file', () => {
    expect(splitChangelogSections('# Kilo App Changelog\n')).toEqual(['# Kilo App Changelog\n']);
    expect(splitChangelogSections('')).toEqual(['']);
  });
});
