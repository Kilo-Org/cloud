/**
 * Utilities for the GitSource discriminated union.
 *
 * These helpers convert between the flat git fields used at I/O boundaries
 * (CloudAgentSessionState, API requests) and the typed GitSource union used
 * in internal execution types.
 */

import type { GitSource } from './types.js';

// ---------------------------------------------------------------------------
// Flat → GitSource conversion
// ---------------------------------------------------------------------------

type FlatGitFields = {
  githubRepo?: string;
  githubToken?: string;
  gitUrl?: string;
  gitToken?: string;
  platform?: 'github' | 'gitlab';
};

/**
 * Convert flat git fields into a typed GitSource union value.
 * Returns `undefined` if neither githubRepo nor gitUrl is present.
 * Prefers githubRepo when both are provided.
 */
export function toGitSource(flat: FlatGitFields): GitSource | undefined {
  if (flat.githubRepo) {
    return { platform: 'github', githubRepo: flat.githubRepo, token: flat.githubToken };
  }
  if (flat.gitUrl) {
    // Default to gitlab for generic git URLs (non-GitHub repos)
    const platform = flat.platform ?? 'gitlab';
    if (platform === 'github') {
      // gitUrl with github platform — extract repo from URL or use as-is
      const match = flat.gitUrl.match(/github\.com\/([^/]+\/[^/.]+)/);
      return { platform: 'github', githubRepo: match?.[1] ?? flat.gitUrl, token: flat.gitToken };
    }
    return { platform: 'gitlab', url: flat.gitUrl, token: flat.gitToken };
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// GitSource → flat fields (for legacy consumers)
// ---------------------------------------------------------------------------

type FlatGitFieldsOut = {
  githubRepo?: string;
  githubToken?: string;
  gitUrl?: string;
  gitToken?: string;
  platform?: 'github' | 'gitlab';
};

/**
 * Extract flat git fields from a GitSource.
 * Used when interfacing with code that still uses the flat field layout
 * (e.g., session-service, workspace helpers).
 */
export function fromGitSource(source: GitSource | undefined): FlatGitFieldsOut {
  if (!source) return {};
  if (source.platform === 'github') {
    return { githubRepo: source.githubRepo, githubToken: source.token, platform: 'github' };
  }
  return { gitUrl: source.url, gitToken: source.token, platform: source.platform };
}

/**
 * Get the GitHub "owner/repo" string from a GitSource, if applicable.
 */
export function getGithubRepo(source: GitSource | undefined): string | undefined {
  if (source?.platform === 'github') return source.githubRepo;
  return undefined;
}

// ---------------------------------------------------------------------------
// GitSource → clone URL
// ---------------------------------------------------------------------------

/**
 * Build a git clone URL from a GitSource.
 * Replaces the old `buildGitCloneUrl()` in workspace.ts.
 */
export function getGitCloneUrl(source: GitSource): string {
  if (source.platform === 'github') {
    if (source.token) {
      return `https://x-access-token:${source.token}@github.com/${source.githubRepo}.git`;
    }
    return `https://github.com/${source.githubRepo}.git`;
  }

  // gitlab (or other platforms using URL-based auth)
  if (source.token) {
    const urlObj = new URL(source.url);
    urlObj.username = 'oauth2';
    urlObj.password = source.token;
    return urlObj.toString();
  }
  return source.url;
}
