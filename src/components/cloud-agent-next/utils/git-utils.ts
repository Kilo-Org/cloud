/**
 * Git URL Utilities
 *
 * Pure utility functions for parsing and extracting information from git URLs.
 * This module has no dependencies on other cloud-agent-next modules to avoid circular imports.
 */

import { PLATFORM } from '@/lib/integrations/core/constants';

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
      const fullPath = pathParts.join('/');
      if (fullPath.endsWith('.git')) {
        return fullPath.replace(/\.git$/, '');
      }
      // GitLab uses /-/ to separate the project path from resource paths
      // (e.g. gitlab.com/group/subgroup/project/-/merge_requests/1)
      const dashIdx = pathParts.indexOf('-');
      if (dashIdx >= 2) {
        return pathParts.slice(0, dashIdx).join('/');
      }
      if (url.hostname === 'gitlab.com') {
        return fullPath;
      }
      // Fallback for GitHub-style URLs: owner/repo (first two segments)
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

  if (options.platform === PLATFORM.GITLAB) {
    return { gitlabProject: repo };
  }

  return { githubRepo: repo };
}

export function buildRepoBrowseUrl(gitUrl: string | null | undefined): string | undefined {
  if (!gitUrl) return undefined;

  // SSH format: git@host:path.git
  const sshMatch = gitUrl.match(/^git@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    return `https://${sshMatch[1]}/${sshMatch[2]}`;
  }

  // Standard URL format (https://, ssh://, etc.)
  try {
    const url = new URL(gitUrl);
    const pathname = url.pathname.replace(/\.git$/, '');
    // For non-browseable protocols (e.g. ssh://git@github.com/owner/repo.git),
    // url.origin is null — force https:// so the result is a clickable URL.
    const origin =
      url.protocol === 'http:' || url.protocol === 'https:'
        ? url.origin
        : `https://${url.hostname}`;
    return origin + pathname;
  } catch {
    return undefined;
  }
}

export function detectGitPlatform(gitUrl: string | null | undefined): GitPlatform | undefined {
  if (!gitUrl) return undefined;

  let hostname: string | undefined;

  // SSH format: git@host:...
  const sshMatch = gitUrl.match(/^git@([^:]+):/);
  if (sshMatch) {
    hostname = sshMatch[1];
  } else {
    try {
      hostname = new URL(gitUrl).hostname;
    } catch {
      return undefined;
    }
  }

  if (hostname === 'github.com') return 'github';
  if (hostname === 'gitlab.com') return 'gitlab';
  return undefined;
}

/**
 * Find all GitHub or GitLab URLs in free-form text, in order of appearance.
 *
 * Useful for detecting when a user pastes links to issues, PRs, etc.
 * Returns all matches so the caller can iterate and pick the first one
 * that corresponds to a connected repository.
 */
export function findAllGitPlatformUrls(text: string): string[] {
  const matches = text.matchAll(/https?:\/\/(?:github\.com|gitlab\.com)\/[^\s)>\]]+/g);
  return Array.from(matches, m => m[0].replace(/[.,;:!?]+$/, ''));
}
