import { describe, test, expect } from '@jest/globals';
import {
  buildRepoBrowseUrl,
  detectGitPlatform,
  extractRepoFromGitUrl,
  buildPrepareSessionRepoParams,
  findAllGitPlatformUrls,
} from './git-utils';

describe('buildRepoBrowseUrl', () => {
  test('GitHub HTTPS with .git', () => {
    expect(buildRepoBrowseUrl('https://github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo'
    );
  });

  test('GitHub HTTPS without .git', () => {
    expect(buildRepoBrowseUrl('https://github.com/owner/repo')).toBe(
      'https://github.com/owner/repo'
    );
  });

  test('GitHub SSH', () => {
    expect(buildRepoBrowseUrl('git@github.com:owner/repo.git')).toBe(
      'https://github.com/owner/repo'
    );
  });

  test('GitHub SSH without .git', () => {
    expect(buildRepoBrowseUrl('git@github.com:owner/repo')).toBe('https://github.com/owner/repo');
  });

  test('GitLab HTTPS', () => {
    expect(buildRepoBrowseUrl('https://gitlab.com/group/project.git')).toBe(
      'https://gitlab.com/group/project'
    );
  });

  test('GitLab nested groups', () => {
    expect(buildRepoBrowseUrl('https://gitlab.com/group/subgroup/project.git')).toBe(
      'https://gitlab.com/group/subgroup/project'
    );
  });

  test('GitLab SSH', () => {
    expect(buildRepoBrowseUrl('git@gitlab.com:group/project.git')).toBe(
      'https://gitlab.com/group/project'
    );
  });

  test('self-hosted HTTPS', () => {
    expect(buildRepoBrowseUrl('https://gitlab.mycompany.com/team/repo.git')).toBe(
      'https://gitlab.mycompany.com/team/repo'
    );
  });

  test('self-hosted SSH', () => {
    expect(buildRepoBrowseUrl('git@gitlab.mycompany.com:team/repo.git')).toBe(
      'https://gitlab.mycompany.com/team/repo'
    );
  });

  test('ssh:// URI format with .git', () => {
    expect(buildRepoBrowseUrl('ssh://git@github.com/owner/repo.git')).toBe(
      'https://github.com/owner/repo'
    );
  });

  test('ssh:// URI format without .git', () => {
    expect(buildRepoBrowseUrl('ssh://git@github.com/owner/repo')).toBe(
      'https://github.com/owner/repo'
    );
  });

  test('ssh:// URI format GitLab nested groups', () => {
    expect(buildRepoBrowseUrl('ssh://git@gitlab.com/group/subgroup/project.git')).toBe(
      'https://gitlab.com/group/subgroup/project'
    );
  });

  test('null returns undefined', () => {
    expect(buildRepoBrowseUrl(null)).toBeUndefined();
  });

  test('undefined returns undefined', () => {
    expect(buildRepoBrowseUrl(undefined)).toBeUndefined();
  });

  test('empty string returns undefined', () => {
    expect(buildRepoBrowseUrl('')).toBeUndefined();
  });
});

describe('detectGitPlatform', () => {
  test('GitHub HTTPS', () => {
    expect(detectGitPlatform('https://github.com/owner/repo.git')).toBe('github');
  });

  test('GitHub SSH', () => {
    expect(detectGitPlatform('git@github.com:owner/repo.git')).toBe('github');
  });

  test('GitLab HTTPS', () => {
    expect(detectGitPlatform('https://gitlab.com/group/project.git')).toBe('gitlab');
  });

  test('GitLab SSH', () => {
    expect(detectGitPlatform('git@gitlab.com:group/project.git')).toBe('gitlab');
  });

  test('self-hosted GitLab HTTPS returns undefined', () => {
    expect(detectGitPlatform('https://gitlab.mycompany.com/team/repo.git')).toBeUndefined();
  });

  test('self-hosted SSH returns undefined', () => {
    expect(detectGitPlatform('git@gitlab.mycompany.com:team/repo.git')).toBeUndefined();
  });

  test('GitHub ssh:// URI format', () => {
    expect(detectGitPlatform('ssh://git@github.com/owner/repo.git')).toBe('github');
  });

  test('GitLab ssh:// URI format', () => {
    expect(detectGitPlatform('ssh://git@gitlab.com/group/project.git')).toBe('gitlab');
  });

  test('Bitbucket returns undefined', () => {
    expect(detectGitPlatform('https://bitbucket.org/owner/repo.git')).toBeUndefined();
  });

  test('null returns undefined', () => {
    expect(detectGitPlatform(null)).toBeUndefined();
  });

  test('undefined returns undefined', () => {
    expect(detectGitPlatform(undefined)).toBeUndefined();
  });
});

describe('extractRepoFromGitUrl', () => {
  test('GitHub HTTPS with .git', () => {
    expect(extractRepoFromGitUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  test('GitLab SSH nested groups', () => {
    expect(extractRepoFromGitUrl('git@gitlab.com:group/subgroup/project.git')).toBe(
      'group/subgroup/project'
    );
  });

  test('ssh:// URI format', () => {
    expect(extractRepoFromGitUrl('ssh://git@github.com/owner/repo.git')).toBe('owner/repo');
  });

  test('ssh:// URI format GitLab nested groups', () => {
    expect(extractRepoFromGitUrl('ssh://git@gitlab.com/group/subgroup/project.git')).toBe(
      'group/subgroup/project'
    );
  });

  test('GitHub issue URL extracts owner/repo', () => {
    expect(extractRepoFromGitUrl('https://github.com/owner/repo/issues/42')).toBe('owner/repo');
  });

  test('GitLab merge request URL extracts group/project', () => {
    expect(extractRepoFromGitUrl('https://gitlab.com/group/project/-/merge_requests/1')).toBe(
      'group/project'
    );
  });

  test('GitLab nested group merge request URL extracts full project path', () => {
    expect(
      extractRepoFromGitUrl('https://gitlab.com/group/subgroup/project/-/merge_requests/1')
    ).toBe('group/subgroup/project');
  });

  test('GitLab nested plain project URL extracts full project path', () => {
    expect(extractRepoFromGitUrl('https://gitlab.com/group/subgroup/project')).toBe(
      'group/subgroup/project'
    );
  });

  test('GitLab deeply nested group issue URL extracts full project path', () => {
    expect(extractRepoFromGitUrl('https://gitlab.com/a/b/c/project/-/issues/5')).toBe(
      'a/b/c/project'
    );
  });

  test('null returns undefined', () => {
    expect(extractRepoFromGitUrl(null)).toBeUndefined();
  });
});

describe('buildPrepareSessionRepoParams', () => {
  test('github platform with repo', () => {
    expect(buildPrepareSessionRepoParams({ repo: 'owner/repo', platform: 'github' })).toEqual({
      githubRepo: 'owner/repo',
    });
  });

  test('gitlab platform with repo', () => {
    expect(buildPrepareSessionRepoParams({ repo: 'group/project', platform: 'gitlab' })).toEqual({
      gitlabProject: 'group/project',
    });
  });

  test('null repo returns null', () => {
    expect(buildPrepareSessionRepoParams({ repo: null, platform: 'github' })).toBeNull();
  });

  test('empty string repo returns null', () => {
    expect(buildPrepareSessionRepoParams({ repo: '', platform: 'github' })).toBeNull();
  });
});

describe('findAllGitPlatformUrls', () => {
  test('extracts GitHub URL from plain text', () => {
    expect(findAllGitPlatformUrls('Fix https://github.com/owner/repo/issues/42 please')).toEqual([
      'https://github.com/owner/repo/issues/42',
    ]);
  });

  test('extracts GitLab URL', () => {
    expect(
      findAllGitPlatformUrls('See https://gitlab.com/group/project/-/merge_requests/1')
    ).toEqual(['https://gitlab.com/group/project/-/merge_requests/1']);
  });

  test('returns all URLs in order when multiple are present', () => {
    expect(findAllGitPlatformUrls('https://github.com/a/b and https://gitlab.com/c/d')).toEqual([
      'https://github.com/a/b',
      'https://gitlab.com/c/d',
    ]);
  });

  test('returns empty array when no platform URL is present', () => {
    expect(findAllGitPlatformUrls('Check https://example.com/foo')).toEqual([]);
  });

  test('handles URL inside markdown link', () => {
    expect(findAllGitPlatformUrls('[link](https://github.com/owner/repo)')).toEqual([
      'https://github.com/owner/repo',
    ]);
  });

  test('strips trailing period', () => {
    expect(findAllGitPlatformUrls('See https://github.com/owner/repo.')).toEqual([
      'https://github.com/owner/repo',
    ]);
  });

  test('strips trailing comma', () => {
    expect(findAllGitPlatformUrls('Check https://github.com/owner/repo, then do X')).toEqual([
      'https://github.com/owner/repo',
    ]);
  });

  test('handles empty string', () => {
    expect(findAllGitPlatformUrls('')).toEqual([]);
  });

  test('handles text with no URLs', () => {
    expect(findAllGitPlatformUrls('Just some plain text')).toEqual([]);
  });

  test('extracts multiple URLs from mixed platforms', () => {
    const text =
      'Fix https://github.com/org/frontend/issues/1, related to https://gitlab.com/org/backend/-/issues/5 and https://github.com/org/shared/pull/10';
    expect(findAllGitPlatformUrls(text)).toEqual([
      'https://github.com/org/frontend/issues/1',
      'https://gitlab.com/org/backend/-/issues/5',
      'https://github.com/org/shared/pull/10',
    ]);
  });
});
