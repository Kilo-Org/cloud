import { describe, expect, it } from 'vitest';

import { formatGitUrlProject } from './git-url-project';

describe('formatGitUrlProject (percent-decoded segments)', () => {
  it('decodes an encoded CJK repository name in an https URL', () => {
    expect(formatGitUrlProject('https://github.com/org/%E5%B1%B1%E7%94%B0-API.git')).toBe(
      'org/山田-API'
    );
    expect(formatGitUrlProject('https://github.com/org/%E5%B1%B1%E7%94%B0-API')).toBe(
      'org/山田-API'
    );
  });

  it('decodes an encoded CJK repository name in an ssh URL', () => {
    expect(formatGitUrlProject('git@github.com:org/%E5%B1%B1%E7%94%B0-API.git')).toBe(
      'org/山田-API'
    );
    expect(formatGitUrlProject('git@github.com:org/%E5%B1%B1%E7%94%B0-API')).toBe('org/山田-API');
  });

  it('decodes every path segment, not only the repository name', () => {
    expect(
      formatGitUrlProject(
        'https://gitlab.com/%E7%A7%BB%E5%8A%A8%E7%AB%AF/%D0%BC%D0%B5%D1%82%D0%B0%D0%B4%D0%B0%D0%BD%D0%BD%D1%8B%D0%B5.git'
      )
    ).toBe('移动端/метаданные');
  });

  it('keeps the GitLab dash-separated project form while decoding', () => {
    expect(
      formatGitUrlProject('https://gitlab.com/group/%E7%A7%BB%E5%8A%A8%E7%AB%AF/-/tree/main')
    ).toBe('group/移动端');
  });

  it('keeps a malformed escape raw instead of throwing', () => {
    expect(formatGitUrlProject('https://github.com/org/%E5%B1%B1%ZZ-repo.git')).toBe(
      'org/%E5%B1%B1%ZZ-repo'
    );
    expect(formatGitUrlProject('https://github.com/org/100%-repo.git')).toBe('org/100%-repo');
    expect(formatGitUrlProject('git@github.com:org/100%-repo.git')).toBe('org/100%-repo');
  });

  it('decodes %25 to a single % and never decodes the value twice', () => {
    expect(formatGitUrlProject('https://github.com/org/50%2525-off.git')).toBe('org/50%25-off');
    expect(formatGitUrlProject('https://github.com/org/50%25-off.git')).toBe('org/50%-off');
  });

  it('leaves an already-decoded URL unchanged', () => {
    expect(formatGitUrlProject('https://github.com/org/山田-API.git')).toBe('org/山田-API');
    expect(formatGitUrlProject('git@github.com:org/метаданные.git')).toBe('org/метаданные');
  });

  it('ends the path at a query string or a fragment', () => {
    expect(formatGitUrlProject('https://github.com/org/repo.git?tab=readme#install')).toBe(
      'org/repo'
    );
    expect(formatGitUrlProject('https://github.com/org/repo#install')).toBe('org/repo');
  });

  it('returns a value that is not a URL unchanged', () => {
    expect(formatGitUrlProject('org/repo')).toBe('org/repo');
    expect(formatGitUrlProject('repo')).toBe('repo');
    expect(formatGitUrlProject('')).toBe('');
  });
});

describe('formatGitUrlProject (one project-path pipeline)', () => {
  it('strips one `.git` from a doubled suffix in an https URL', () => {
    expect(formatGitUrlProject('https://github.com/owner/repo.git.git')).toBe('owner/repo.git');
  });

  it('strips one `.git` from a doubled suffix in an ssh URL', () => {
    expect(formatGitUrlProject('git@github.com:owner/repo.git.git')).toBe('owner/repo.git');
  });

  it('drops a trailing slash in an https URL', () => {
    expect(formatGitUrlProject('https://github.com/owner/repo/')).toBe('owner/repo');
  });

  it('drops a trailing slash in an ssh URL', () => {
    expect(formatGitUrlProject('git@github.com:owner/repo/')).toBe('owner/repo');
  });

  it('ends the project path at a `/-/` suffix in an https URL', () => {
    expect(formatGitUrlProject('https://github.com/owner/repo/-/tree/main')).toBe('owner/repo');
  });

  it('ends the project path at a `/-/` suffix in an ssh URL', () => {
    expect(formatGitUrlProject('git@github.com:owner/repo/-/tree/main')).toBe('owner/repo');
  });

  it('formats the https and ssh spelling of a repository identically', () => {
    for (const path of ['owner/repo.git.git', 'owner/repo/', 'owner/repo/-/tree/main']) {
      expect(formatGitUrlProject(`https://github.com/${path}`)).toBe(
        formatGitUrlProject(`git@github.com:${path}`)
      );
    }
  });
});
