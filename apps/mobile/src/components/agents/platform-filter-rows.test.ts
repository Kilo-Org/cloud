import { describe, expect, it } from 'vitest';

import { mergeProjectOptions } from './platform-filter-rows';

const ALPHA = 'https://github.com/kilo/alpha.git';
const BETA = 'https://github.com/kilo/beta.git';
const GAMMA = 'https://github.com/kilo/gamma.git';

describe('mergeProjectOptions', () => {
  it('offers recent repositories and session repositories, deduped in first-seen order', () => {
    const options = mergeProjectOptions({
      recentProjects: [ALPHA],
      sessionGitUrls: [ALPHA, BETA],
      selectedProjects: [BETA, GAMMA],
    });

    expect(options).toEqual([
      { gitUrl: ALPHA, displayName: 'kilo/alpha' },
      { gitUrl: BETA, displayName: 'kilo/beta' },
      { gitUrl: GAMMA, displayName: 'kilo/gamma' },
    ]);
  });

  it('offers a repository that only a session row carries', () => {
    const options = mergeProjectOptions({
      recentProjects: [],
      sessionGitUrls: ['git@github.com:kilo/legacy.git'],
      selectedProjects: [],
    });

    expect(options).toEqual([
      { gitUrl: 'git@github.com:kilo/legacy.git', displayName: 'kilo/legacy' },
    ]);
  });

  it('skips null, undefined and empty git URLs', () => {
    const options = mergeProjectOptions({
      recentProjects: [],
      sessionGitUrls: [null, undefined, '', ALPHA],
      selectedProjects: [],
    });

    expect(options).toEqual([{ gitUrl: ALPHA, displayName: 'kilo/alpha' }]);
  });

  it('offers a selected repository nothing else lists, so the filter stays removable', () => {
    const options = mergeProjectOptions({
      recentProjects: [ALPHA],
      sessionGitUrls: [null],
      selectedProjects: [BETA],
    });

    expect(options).toEqual([
      { gitUrl: ALPHA, displayName: 'kilo/alpha' },
      { gitUrl: BETA, displayName: 'kilo/beta' },
    ]);
  });

  it('sorts the rows by display name', () => {
    const options = mergeProjectOptions({
      recentProjects: [GAMMA, ALPHA],
      sessionGitUrls: ['https://github.com/kilo/delta.git', BETA],
      selectedProjects: ['https://github.com/kilo/epsilon.git'],
    });

    expect(options.map(option => option.displayName)).toEqual([
      'kilo/alpha',
      'kilo/beta',
      'kilo/delta',
      'kilo/epsilon',
      'kilo/gamma',
    ]);
  });

  it('gives no rows for empty input', () => {
    expect(
      mergeProjectOptions({ recentProjects: [], sessionGitUrls: [], selectedProjects: [] })
    ).toEqual([]);
  });
});
