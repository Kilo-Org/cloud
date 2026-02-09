/**
 * Git URL Utilities
 *
 * Pure utility functions for parsing and extracting information from git URLs.
 * This module has no dependencies on other cloud-agent-next modules to avoid circular imports.
 */

/**
 * Extract owner/repo or group/project from a git URL
 *
 * Supports formats:
 * - https://github.com/owner/repo
 * - https://github.com/owner/repo.git
 * - git@github.com:owner/repo.git
 * - git@github.com:owner/repo
 * - https://gitlab.com/group/project.git
 * - https://gitlab.com/group/subgroup/project.git (nested GitLab groups)
 * - git@gitlab.com:group/project.git
 * - git@gitlab.com:group/subgroup/project.git (nested GitLab groups)
 *
 * @param gitUrl - The git URL to parse
 * @returns owner/repo or group/project format string, or undefined if parsing fails
 */
export function extractRepoFromGitUrl(gitUrl: string | null | undefined): string | undefined {
  if (!gitUrl) return undefined;

  // SSH format: git@github.com:owner/repo.git or git@gitlab.com:group/subgroup/project.git
  const sshMatch = gitUrl.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return sshMatch[1];
  }

  // HTTPS format: https://github.com/owner/repo.git or https://gitlab.com/group/subgroup/project.git
  try {
    const url = new URL(gitUrl);
    const pathParts = url.pathname.split('/').filter(Boolean);
    if (pathParts.length >= 2) {
      // For clone URLs (ending in .git), use the full path (supports nested GitLab groups)
      // For non-clone URLs (like GitHub tree URLs), only use first two segments
      const fullPath = pathParts.join('/');
      if (fullPath.endsWith('.git')) {
        return fullPath.replace(/\.git$/, '');
      }
      // Non-clone URL: only take owner/repo (first two segments)
      return `${pathParts[0]}/${pathParts[1]}`;
    }
  } catch {
    // Not a valid URL
  }

  return undefined;
}

export type GitPlatform = 'github' | 'gitlab';

export function buildPrepareSessionRepoParams(options: {
  repo?: string | null;
  platform: GitPlatform;
}): { githubRepo?: string; gitlabProject?: string } | null {
  const repo = options.repo?.trim();
  if (!repo) return null;

  if (options.platform === 'gitlab') {
    return { gitlabProject: repo };
  }

  return { githubRepo: repo };
}
