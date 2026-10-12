import { isOrgInList } from '../../sandbox-id.js';
import { ISOLATED_CONTAINER_WORKSPACE_PATH } from '../../workspace.js';

const REPO_KEY_DOMAIN = 'kilo:repo-snapshot-key:v1';

export type RepoKeyInput = {
  /** The Worker secret the hash is keyed with; absent disables repository snapshots. */
  secret: string | null;
  /** Snapshot scope. Per user for now; widening to the org is a change to this field. */
  userId: string;
  repoUrl: string | undefined;
  directory: string;
};

export type RepoSnapshotGate = {
  /** User or org IDs admitted. `*` includes everyone. */
  enrolledIds: string | undefined;
  userId: string;
  orgId: string | undefined;
};

export type RepoSnapshotIneligibilityReason =
  | 'not_enrolled'
  | 'no_repo_url'
  | 'directory_not_isolated'
  | 'has_setup_commands';

export type RepoSnapshotEligibility =
  | { eligible: true }
  | { eligible: false; reason: RepoSnapshotIneligibilityReason };

/**
 * Why a route is or is not eligible to use a repository snapshot. This is the one
 * owner of the decision; `repoSnapshotEligible` is the boolean projection for
 * callers that do not need the reason (the reason is logged when the key is null).
 *
 * The owner (personal user, or the org when the session is org-owned) must be
 * enrolled, and the route must have a repository at the constant path the
 * snapshots are taken at. A snapshot holds one repository at one path, so a
 * per-session path or a shared sandbox could only capture something no later
 * session can reuse. A route with any setup command is ineligible: capture runs
 * after setup, so the snapshot would carry setup output under a key that names
 * only the user and the repository.
 *
 * Enrollment follows the `SANDBOX_SELECTION_IDS` allowlist convention:
 * one list matched against the user ID and then the org ID.
 */
export function repoSnapshotEligibility(
  gate: RepoSnapshotGate,
  route: Pick<RepoKeyInput, 'repoUrl' | 'directory'> & { setupCommands?: string[] }
): RepoSnapshotEligibility {
  if ((route.setupCommands?.length ?? 0) > 0) {
    return { eligible: false, reason: 'has_setup_commands' };
  }
  if (!(isOrgInList(gate.enrolledIds, gate.userId) || isOrgInList(gate.enrolledIds, gate.orgId))) {
    return { eligible: false, reason: 'not_enrolled' };
  }
  if (route.repoUrl === undefined) return { eligible: false, reason: 'no_repo_url' };
  if (route.directory !== ISOLATED_CONTAINER_WORKSPACE_PATH) {
    return { eligible: false, reason: 'directory_not_isolated' };
  }
  return { eligible: true };
}

export function repoSnapshotEligible(
  gate: RepoSnapshotGate,
  route: Pick<RepoKeyInput, 'repoUrl' | 'directory'> & { setupCommands?: string[] }
): boolean {
  return repoSnapshotEligibility(gate, route).eligible;
}

/**
 * The keyed hash that names a repository snapshot: scope and repository. Env is
 * not part of it on purpose: setup re-runs on every start and rewrites what it
 * derives from the env. Setup-command output is kept out by not computing a key
 * for a route that has setup commands, rather than by narrowing the hash. It is
 * hashed under a Worker secret so the digest cannot be guessed to address
 * another user's snapshot.
 */
export async function computeRepoKey(input: RepoKeyInput): Promise<string | null> {
  if (input.secret === null || input.repoUrl === undefined) return null;
  const message = JSON.stringify([REPO_KEY_DOMAIN, input.userId, input.repoUrl]);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(input.secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(message)));
  return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
}
