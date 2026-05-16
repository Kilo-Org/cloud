/**
 * Branch-name conventions used by the wl protocol.
 *
 * Mutation branches:
 *   `wl/<rigHandle>/<wantedId>`
 *
 * Registration branch (one per rig per wasteland):
 *   `wl/register/<rigHandle>`
 *
 * Mirrors `BranchName` in `wasteland/internal/commons/sql.go:9` and the
 * `wl/register/<handle>` convention in `Service.Join`
 * (`wasteland/internal/federation/federation.go:114`).
 */

import type { BranchName, RigHandle } from './types';

const BRANCH_PREFIX = 'wl/';
const REGISTER_PREFIX = 'wl/register/';

/** Build the per-item mutation branch name. */
export function makeWlBranch(rigHandle: RigHandle, wantedId: string): BranchName {
  return `${BRANCH_PREFIX}${rigHandle}/${wantedId}`;
}

/** Build the per-rig registration branch name. */
export function makeRegisterBranch(rigHandle: RigHandle): BranchName {
  return `${REGISTER_PREFIX}${rigHandle}`;
}

/**
 * Per-rig prefix for listing the caller's mutation branches.
 * `listBranches` doesn't filter server-side, so callers use this to
 * trim the list client-side.
 */
export function rigBranchPrefix(rigHandle: RigHandle): string {
  return `${BRANCH_PREFIX}${rigHandle}/`;
}

/** Discriminated parse result for a wl branch name. */
export type ParsedBranch =
  | { kind: 'wanted'; rigHandle: RigHandle; wantedId: string }
  | { kind: 'register'; rigHandle: RigHandle };

/**
 * Parse a branch name back into its components. Returns `null` for
 * any name that isn't a recognized wl branch (so callers can ignore
 * non-wl branches like `main` or arbitrary user branches).
 */
export function parseWlBranch(branch: string | null | undefined): ParsedBranch | null {
  if (!branch) return null;

  if (branch.startsWith(REGISTER_PREFIX)) {
    const rigHandle = branch.slice(REGISTER_PREFIX.length);
    if (rigHandle === '' || rigHandle.includes('/')) return null;
    return { kind: 'register', rigHandle };
  }

  if (!branch.startsWith(BRANCH_PREFIX)) return null;
  const rest = branch.slice(BRANCH_PREFIX.length);
  const slash = rest.indexOf('/');
  if (slash <= 0) return null;
  const rigHandle = rest.slice(0, slash);
  const wantedId = rest.slice(slash + 1);
  if (rigHandle === '' || wantedId === '') return null;
  // Defend against malformed names like `wl/foo/bar/baz` — wantedIds
  // must not contain a `/` per Go's BranchName format.
  if (wantedId.includes('/')) return null;
  return { kind: 'wanted', rigHandle, wantedId };
}
