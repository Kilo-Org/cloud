/**
 * Shared GitHub collaborator permission helpers.
 *
 * Single source of truth for the permission levels that count as write access
 * and for parsing GitHub's collaborator-permission API response. Consumed by
 * both the Next.js app (via the octokit-based adapter) and Cloudflare Workers
 * (via the fetch-based helper below).
 */

export type CollaboratorPermission = 'admin' | 'maintain' | 'write' | 'read' | 'none';

const COLLABORATOR_PERMISSION_LEVELS: Record<string, true> = {
  admin: true,
  maintain: true,
  write: true,
  read: true,
  none: true,
};

/** Permission levels that imply repository write access. */
export const WRITE_ACCESS_PERMISSION_LEVELS: Record<string, true> = {
  admin: true,
  maintain: true,
  write: true,
};

/** True when the lookup succeeded and the level implies write access. */
export function hasWriteAccess(permission: CollaboratorPermission | null): boolean {
  return permission !== null && WRITE_ACCESS_PERMISSION_LEVELS[permission] === true;
}

/**
 * Parse a GitHub collaborator-permission response body into a known level.
 * Returns null for unexpected shapes so callers can fail closed.
 */
export function parseCollaboratorPermission(body: unknown): CollaboratorPermission | null {
  if (typeof body !== 'object' || body === null || !('permission' in body)) return null;
  const permission: unknown = body.permission;
  if (
    typeof permission !== 'string' ||
    !Object.hasOwn(COLLABORATOR_PERMISSION_LEVELS, permission)
  ) {
    return null;
  }
  return permission as CollaboratorPermission;
}

/**
 * Look up a user's repository permission with a plain GitHub REST call
 * (`GET /repos/{owner}/{repo}/collaborators/{username}/permission`).
 *
 * Intended for Workers and other environments without octokit. Returns null
 * when the request fails or the response is unexpected; callers must treat
 * null as "cannot verify" and deny elevated actions.
 */
export async function fetchCollaboratorPermission(
  repoFullName: string,
  username: string,
  githubToken: string
): Promise<CollaboratorPermission | null> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repoFullName}/collaborators/${encodeURIComponent(
        username
      )}/permission`,
      {
        headers: {
          Authorization: `Bearer ${githubToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Kilo-Auto-Triage',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );

    if (!response.ok) {
      console.warn('[github-collaborator-permission] Non-2xx from permission API', {
        repoFullName,
        status: response.status,
      });
      return null;
    }

    return parseCollaboratorPermission(await response.json());
  } catch (error) {
    console.warn('[github-collaborator-permission] Permission lookup failed', {
      repoFullName,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
