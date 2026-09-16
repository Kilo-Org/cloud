import { z } from 'zod';

/**
 * Durable capture of a worktree's *uncommitted* state, so that destroying the
 * shared physical sandbox — the 5 minute `idleStop` in particular — no longer
 * throws the agent's in-progress work away.
 *
 * The bundle is deliberately small: a `git diff HEAD --binary` patch plus the
 * untracked files git itself would report (so `.gitignore` already excludes
 * `node_modules/` and build output, which setup commands recreate anyway).
 * Preserving those would need a full workspace snapshot; preserving edits only
 * needs a patch.
 */

/** Bundle lifetime. Matches the prepared-workspace backup TTL. */
export const WORKTREE_STATE_TTL_MS = 24 * 60 * 60 * 1000;
/**
 * Grant lifetime. Longer than the log-upload grant because a grant is minted
 * once per wrapper instance (on attach) and has to outlive a wrapper that stays
 * continuously busy.
 */
export const WORKTREE_STATE_GRANT_SECONDS = 12 * 60 * 60;
/**
 * Total budget for one capture. A turn is not reported until the capture
 * finishes, so a slow or stuck worktree must give up rather than make the user
 * wait on it.
 */
export const WORKTREE_STATE_CAPTURE_BUDGET_MS = 30_000;
/**
 * Total budget for one restore. Session attachment already spends most of its
 * deadline on cloning and setup commands, so a slow restore must give up
 * rather than turn a skippable step into a failed attach.
 */
export const WORKTREE_STATE_RESTORE_BUDGET_MS = 60_000;
/** Upper bound on the compressed bundle. Larger dirty state is not captured. */
export const WORKTREE_STATE_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Ceiling on how many untracked files one bundle may carry. Shared by the
 * producer and the bundle schema so a worktree can never build a bundle its
 * own schema would reject.
 */
export const WORKTREE_STATE_MAX_UNTRACKED_FILES = 4096;

export const WORKTREE_STATE_BUNDLE_VERSION = 1;
export const WORKTREE_STATE_PATCH_ENTRY = 'tracked.patch';
export const WORKTREE_STATE_META_ENTRY = 'meta.json';
export const WORKTREE_STATE_UNTRACKED_PREFIX = 'untracked/';

/**
 * Federated identities look like `oauth/google:1234`. `/` and `:` are encoded
 * in the object key and route, so they are safe here; `..` is not.
 */
export const worktreeStateUserIdSchema = z
  .string()
  .regex(/^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9._/:-]{0,255}$/);
export const worktreeStateScopeIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/);

export const worktreeStateIdentitySchema = z
  .object({
    userId: worktreeStateUserIdSchema,
    scopeId: worktreeStateScopeIdSchema,
  })
  .strict();

export type WorktreeStateIdentity = z.infer<typeof worktreeStateIdentitySchema>;

/**
 * `meta.json` inside the bundle. `head` is the commit the patch was produced
 * against: a restore onto a different commit is refused rather than risking a
 * half-applied worktree.
 */
export const worktreeStateMetaSchema = z
  .object({
    version: z.literal(WORKTREE_STATE_BUNDLE_VERSION),
    head: z.string().regex(/^[a-f0-9]{40,64}$/),
    capturedAt: z.number().int().nonnegative(),
    hasPatch: z.boolean(),
    untracked: z.array(z.string().min(1).max(4096)).max(WORKTREE_STATE_MAX_UNTRACKED_FILES),
  })
  .strict();

export type WorktreeStateMeta = z.infer<typeof worktreeStateMetaSchema>;

export function worktreeStateObjectKey(identity: WorktreeStateIdentity): string {
  return `worktree-state/v1/${encodeURIComponent(identity.userId)}/${encodeURIComponent(
    identity.scopeId
  )}/state.tar.gz`;
}

export function worktreeStateEndpointUrl(
  workerUrl: string,
  identity: WorktreeStateIdentity
): string {
  const base = workerUrl.replace(/\/$/, '');
  return `${base}/worktree-state/${encodeURIComponent(identity.userId)}/${encodeURIComponent(
    identity.scopeId
  )}`;
}
