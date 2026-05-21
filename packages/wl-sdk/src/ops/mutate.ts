/**
 * Shared "apply DML to a fork branch" primitive.
 *
 * Every PR-mode mutation op (`claim`, `unclaim`, `done`, `accept`,
 * `reject`, `close`, `post`) shares the same wire-level lifecycle:
 *
 *   1. Resolve the target branch — `wl/<rig>/<wantedId>`.
 *   2. Idempotency check: if the branch's row already matches the
 *      desired status, skip the write and return `alreadyApplied: true`.
 *   3. Issue the DML through DoltHub's write API. The first write
 *      branches off `main`; subsequent writes commit onto the existing
 *      branch.
 *   4. Auto-cleanup: if the post-mutation branch row matches upstream
 *      `main` (e.g. a claim → unclaim sequence with no other state),
 *      delete the branch so the wanted-board overlay no longer flags
 *      it as pending.
 *
 * No PR is opened from here — that is the deliberate `publish` op.
 *
 * Mirrors `mutatePR` in `wasteland/internal/sdk/mutate.go:61`. Differs
 * in scope: the Go reference also covers the wild-west / direct mode
 * (push to upstream `main`); the wl-sdk targets the DoltHub REST API,
 * which only supports fork → upstream PRs, so we never write to
 * upstream directly.
 */

import { doltWrite } from '../dolthub/write';
import { deleteBranch } from '../dolthub/branches';
import { makeWlBranch } from './branch';
import {
  assertForkMainCurrent,
  readWantedRowAt,
  readWantedStatusAt,
  wantedRowsEquivalent,
} from './state';
import { WlError, type MutationContext, type MutationOutcome } from './types';
import { WlDoltHubError } from '../dolthub/api';

export type ApplyMutationOptions = {
  ctx: MutationContext;
  /** Wanted id this mutation targets. */
  wantedId: string;
  /** Status the branch will hold after the mutation succeeds. */
  targetStatus: string;
  /** DML statement(s) to execute against the branch. */
  statements: readonly string[];
  /** Commit message for the DoltHub write. */
  commitMessage: string;
  /**
   * If true, the post-mutation comparison runs against the upstream
   * main row and the branch is deleted when they match. Defaults to
   * `true` — only `post` and similarly create-only ops disable it
   * (since the row never exists on main yet).
   */
  autoCleanup?: boolean;
};

/**
 * Run a single-statement-or-multi-statement mutation against the
 * caller's fork branch, with idempotency and auto-cleanup baked in.
 *
 * Returns `{ alreadyApplied: true }` when the branch already held the
 * target status before this call. Returns `{ cleanedUp: true,
 * branchName: '' }` when the resulting branch state matched main and
 * was deleted.
 */
export async function applyMutation(opts: ApplyMutationOptions): Promise<MutationOutcome> {
  const { ctx, wantedId, targetStatus, statements, commitMessage } = opts;
  const autoCleanup = opts.autoCleanup ?? true;
  const branchName = makeWlBranch(ctx.rigHandle, wantedId);

  // ── 1. Idempotency ─────────────────────────────────────────────
  // Per the wl-sdk plan: skip the write whenever the branch already
  // holds the target status. This deliberately differs from Go's
  // `prIdempotent` (mutate.go:116), which only short-circuits when
  // `branchStatus == targetStatus && branchStatus != mainStatus` —
  // i.e. Go falls through and re-applies the DML when the branch
  // matches main, partly to surface a fresh post-mutation result
  // and partly to drive auto-cleanup on a stale branch that already
  // matches main.
  //
  // The trade-off: a branch that escaped a previous cleanup attempt
  // (network blip on `deleteBranch`, say) and still matches main at
  // `targetStatus` will linger here forever — callers must
  // `discardBranch` it explicitly. That's acceptable in exchange for
  // the simpler "no-op when target reached" guarantee callers expect.
  const branchStatus = await readWantedStatusAt({
    auth: ctx.auth,
    owner: ctx.fork.forkOwner,
    db: ctx.fork.forkDb,
    ref: branchName,
    wantedId,
    fetch: ctx.fetch,
    hooks: ctx.hooks,
  });
  if (branchStatus === targetStatus) {
    return { branchName, alreadyApplied: true, cleanedUp: false };
  }

  // ── 1.5. Stale-fork guard ──────────────────────────────────────
  // The DoltHub hosted SQL API doesn't expose any synchronous fork-sync
  // primitive (verified by probing the live API: `CALL DOLT_FETCH`,
  // `DOLT_PULL`, `DOLT_MERGE('upstream/main', ...)`, and `DOLT_REMOTE`
  // all return `Unsupported SQL statement`; the cross-repo PR-from-
  // upstream-to-fork mechanic requires write permission on upstream
  // which the fork owner doesn't have). So when fork main has fallen
  // behind upstream main, we have to bail out and direct the user to
  // sync manually — otherwise the WHERE clauses in our DML
  // (`WHERE status='open'`, `WHERE claimed_by='<rig>' AND status='claimed'`,
  // etc.) will silently match zero rows and the mutation will appear
  // to succeed at the API layer while landing nothing.
  //
  // Skipping the check when the branch already exists at the target
  // state is the previous block's job; here we only run for "we're
  // about to write something that depends on the branch's base".
  await assertForkMainCurrent({
    auth: ctx.auth,
    upstream: ctx.upstream,
    fork: ctx.fork,
    fetch: ctx.fetch,
    hooks: ctx.hooks,
  });

  // ── 2. Apply each DML statement ────────────────────────────────
  // DoltHub's write API accepts only one statement per request, so
  // multi-statement DML helpers (e.g. submitCompletionDML) fan out
  // across multiple write calls. The first call uses fromBranch=main
  // (which creates the branch when it doesn't exist); subsequent
  // calls use fromBranch=branchName so we accumulate commits on the
  // same branch.
  for (let i = 0; i < statements.length; i++) {
    const stmt = statements[i];
    const fromBranch = i === 0 ? 'main' : branchName;
    try {
      await doltWrite({
        auth: ctx.auth,
        owner: ctx.fork.forkOwner,
        db: ctx.fork.forkDb,
        fromBranch,
        toBranch: branchName,
        query: `${stmt}; -- ${commitMessage}`,
        fetch: ctx.fetch,
        hooks: ctx.hooks,
      });
    } catch (err) {
      if (err instanceof WlDoltHubError && err.status === 401) {
        throw new WlError(`DoltHub auth failed (${err.status})`, 'auth', err);
      }
      throw new WlError(`DoltHub write failed for ${branchName}`, 'upstream', err);
    }
  }

  // ── 3. Auto-cleanup ────────────────────────────────────────────
  if (!autoCleanup) {
    return { branchName, alreadyApplied: false, cleanedUp: false };
  }

  const [upstreamRow, branchRow] = await Promise.all([
    readWantedRowAt({
      auth: ctx.auth,
      owner: ctx.upstream.owner,
      db: ctx.upstream.db,
      // Upstream main is the default ref — pass undefined so we
      // benefit from the branchless anonymous-read fallback.
      ref: undefined,
      wantedId,
      fetch: ctx.fetch,
      hooks: ctx.hooks,
    }),
    readWantedRowAt({
      auth: ctx.auth,
      owner: ctx.fork.forkOwner,
      db: ctx.fork.forkDb,
      ref: branchName,
      wantedId,
      fetch: ctx.fetch,
      hooks: ctx.hooks,
    }),
  ]);

  if (upstreamRow !== null && wantedRowsEquivalent(upstreamRow, branchRow)) {
    // Note: any open PR pointing at this branch will become
    // "from-branch deleted" once the DELETE below lands. Callers who
    // care about closing the PR explicitly should use `unpublish`
    // before letting the branch be auto-cleaned up.
    try {
      await deleteBranch({
        auth: ctx.auth,
        owner: ctx.fork.forkOwner,
        db: ctx.fork.forkDb,
        branch: branchName,
        fetch: ctx.fetch,
        hooks: ctx.hooks,
      });
    } catch {
      // Branch-delete failure is non-fatal: leave the branch in
      // place. The next read will treat it as pending; callers can
      // discard it explicitly via `discardBranch`.
      return { branchName, alreadyApplied: false, cleanedUp: false };
    }
    return { branchName: '', alreadyApplied: false, cleanedUp: true };
  }

  return { branchName, alreadyApplied: false, cleanedUp: false };
}
