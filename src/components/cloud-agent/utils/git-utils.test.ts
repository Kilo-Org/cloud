import { extractRepoFromGitUrl, buildPrepareSessionRepoParams } from './git-utils';

describe('extractRepoFromGitUrl', () => {
  describe('HTTPS URLs', () => {
    it('extracts owner/repo from GitHub HTTPS URL', () => {
      expect(extractRepoFromGitUrl('https://github.com/owner/repo')).toBe('owner/repo');
    });

    it('extracts owner/repo from GitHub HTTPS URL with .git suffix', () => {
      expect(extractRepoFromGitUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
    });

    it('extracts group/project from GitLab HTTPS URL', () => {
      expect(extractRepoFromGitUrl('https://gitlab.com/group/project')).toBe('group/project');
    });

    it('extracts group/project from GitLab HTTPS URL with .git suffix', () => {
      expect(extractRepoFromGitUrl('https://gitlab.com/group/project.git')).toBe('group/project');
    });

    it('extracts only first two segments from GitLab HTTPS URL without .git suffix', () => {
      // Without .git suffix, we can't distinguish between a clone URL and a web URL
      // so we conservatively take only the first two segments (like GitHub)
      expect(extractRepoFromGitUrl('https://gitlab.com/group/subgroup/project')).toBe(
        'group/subgroup'
      );
    });

    it('extracts nested group/subgroup/project from GitLab HTTPS URL with .git suffix', () => {
      expect(extractRepoFromGitUrl('https://gitlab.com/group/subgroup/project.git')).toBe(
        'group/subgroup/project'
      );
    });

    it('extracts deeply nested GitLab project path', () => {
      expect(extractRepoFromGitUrl('https://gitlab.com/a/b/c/d/project.git')).toBe(
        'a/b/c/d/project'
      );
    });

    it('extracts only owner/repo from GitHub tree URL (non-clone URL)', () => {
      expect(extractRepoFromGitUrl('https://github.com/owner/repo/tree/main')).toBe('owner/repo');
    });

    it('extracts only owner/repo from GitHub blob URL (non-clone URL)', () => {
      expect(extractRepoFromGitUrl('https://github.com/owner/repo/blob/main/file.ts')).toBe(
        'owner/repo'
      );
    });
  });

  describe('SSH URLs', () => {
    it('extracts owner/repo from GitHub SSH URL', () => {
      expect(extractRepoFromGitUrl('git@github.com:owner/repo.git')).toBe('owner/repo');
    });

    it('extracts owner/repo from GitHub SSH URL without .git suffix', () => {
      expect(extractRepoFromGitUrl('git@github.com:owner/repo')).toBe('owner/repo');
    });

    it('extracts group/project from GitLab SSH URL', () => {
      expect(extractRepoFromGitUrl('git@gitlab.com:group/project.git')).toBe('group/project');
    });

    it('extracts nested group/subgroup/project from GitLab SSH URL', () => {
      expect(extractRepoFromGitUrl('git@gitlab.com:group/subgroup/project.git')).toBe(
        'group/subgroup/project'
      );
    });

    it('extracts deeply nested GitLab project path from SSH URL', () => {
      expect(extractRepoFromGitUrl('git@gitlab.com:a/b/c/d/project.git')).toBe('a/b/c/d/project');
    });
  });

  describe('edge cases', () => {
    it('returns undefined for null input', () => {
      expect(extractRepoFromGitUrl(null)).toBeUndefined();
    });

    it('returns undefined for undefined input', () => {
      expect(extractRepoFromGitUrl(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string', () => {
      expect(extractRepoFromGitUrl('')).toBeUndefined();
    });

    it('returns undefined for invalid URL', () => {
      expect(extractRepoFromGitUrl('not-a-url')).toBeUndefined();
    });

    it('returns undefined for URL with only one path segment', () => {
      expect(extractRepoFromGitUrl('https://github.com/owner')).toBeUndefined();
    });
  });
});

describe('buildPrepareSessionRepoParams', () => {
  it('uses gitlabProject when platform is gitlab', () => {
    expect(
      buildPrepareSessionRepoParams({
        repo: 'group/project',
        platform: 'gitlab',
      })
    ).toEqual({ gitlabProject: 'group/project' });
  });

  it('uses githubRepo when platform is github', () => {
    expect(
      buildPrepareSessionRepoParams({
        repo: 'owner/repo',
        platform: 'github',
      })
    ).toEqual({ githubRepo: 'owner/repo' });
  });

  it('returns null when repo is empty', () => {
    expect(buildPrepareSessionRepoParams({ repo: '  ', platform: 'github' })).toBeNull();
  });

  it('returns null when repo is null', () => {
    expect(buildPrepareSessionRepoParams({ repo: null, platform: 'github' })).toBeNull();
  });

  it('handles self-hosted GitLab via explicit platform (no gitlab in URL needed)', () => {
    // This is the key fix: self-hosted GitLab instances with custom domains
    // (e.g. git.company.com) are correctly handled via explicit platform
    expect(
      buildPrepareSessionRepoParams({
        repo: 'team/project',
        platform: 'gitlab',
      })
    ).toEqual({ gitlabProject: 'team/project' });
  });

  it('handles nested GitLab group/subgroup via explicit platform', () => {
    expect(
      buildPrepareSessionRepoParams({
        repo: 'group/subgroup/project',
        platform: 'gitlab',
      })
    ).toEqual({ gitlabProject: 'group/subgroup/project' });
  });
});
