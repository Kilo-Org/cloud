import { describe, expect, it } from '@jest/globals';
import { sameGitProject } from './git-url-project';

describe('sameGitProject', () => {
  it('matches a percent-encoded session URL to the decoded repository a list stores', () => {
    expect(
      sameGitProject('https://github.com/org/%E5%B1%B1%E7%94%B0-API.git', 'org/山田-API')
    ).toBe(true);
    expect(
      sameGitProject(
        'git@github.com:org/%D0%BC%D0%B5%D1%82%D0%B0%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5.git',
        'org/метаданные'
      )
    ).toBe(true);
  });

  it('still separates two different repositories', () => {
    expect(sameGitProject('https://github.com/org/%E5%B1%B1%E7%94%B0-API.git', 'org/API')).toBe(
      false
    );
  });

  it('keeps a malformed escape raw instead of failing the comparison', () => {
    expect(sameGitProject('https://github.com/org/%E5%B1%ZZ-api.git', 'org/%E5%B1%ZZ-api')).toBe(
      true
    );
  });
});
