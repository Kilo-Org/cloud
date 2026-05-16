/**
 * Shared types for the wl-sdk ops layer.
 *
 * The ops layer sits on top of `dolthub/*` (typed REST client) and
 * `commons/*` (DML/SQL primitives) and orchestrates the per-rig fork +
 * branch + PR ceremony described in the wasteland Go SDK
 * (`wasteland/internal/sdk/mutate.go`).
 *
 * Every op accepts a {@link MutationContext} that carries the auth, the
 * upstream coordinates, the user's fork coordinates, and the rig
 * handle. Ops are pure functions — no global state — so the same
 * context can be reused across calls.
 */

import type { DoltHubAuth, DoltFetchHooks } from '../dolthub/api';

/** Reference to a wasteland (an upstream `owner/db`). */
export type WastelandRef = {
  /** Upstream DoltHub owner — e.g. `hop`. */
  owner: string;
  /** Upstream DoltHub database — e.g. `wl-commons`. */
  db: string;
};

/**
 * Identifies the caller within a wasteland. The rig handle drives
 * branch naming (`wl/<rigHandle>/<wantedId>`) and is the value written
 * to `claimed_by` / `posted_by` / stamp authorship.
 */
export type RigHandle = string;

/** A wl branch name (`wl/<rig>/<id>` or `wl/register/<rig>`). */
export type BranchName = string;

/**
 * A wl-sdk-specific error thrown by ops. Wraps lower-level DoltHub
 * errors with a coarse code so callers can surface useful messages.
 *
 * Codes:
 *  - `not_joined`        — the user has not forked / registered yet
 *  - `not_found`         — branch / PR / item not found
 *  - `precondition`      — invariant violated (e.g. claim without item on main)
 *  - `auth`              — DoltHub auth failed
 *  - `upstream`          — DoltHub returned an error we can't classify
 *  - `internal`          — bug / unexpected state
 */
export type WlErrorCode =
  | 'not_joined'
  | 'not_found'
  | 'precondition'
  | 'auth'
  | 'upstream'
  | 'internal';

export class WlError extends Error {
  readonly code: WlErrorCode;
  readonly cause?: unknown;

  constructor(message: string, code: WlErrorCode, cause?: unknown) {
    super(message);
    this.name = 'WlError';
    this.code = code;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

/**
 * The fork — the DoltHub repo the caller writes to. `forkOwner` is
 * the user's DoltHub username (or org). `forkDb` is almost always the
 * same string as `upstream.db`; DoltHub doesn't allow renaming forks.
 */
export type ForkRef = {
  forkOwner: string;
  /** Defaults to `upstream.db` at the call site. */
  forkDb: string;
};

/**
 * Context shared by every mutation op. The caller assembles this once
 * per request and passes it through to the per-op functions.
 *
 * `now` and `fetch` are injectable so tests can deterministically
 * exercise both timestamp-sensitive DML and HTTP behavior.
 */
export type MutationContext = {
  /** Auth used for fork writes (must be the user's DoltHub token). */
  auth: DoltHubAuth;
  /** The upstream wasteland (read source for `main`). */
  upstream: WastelandRef;
  /** The user's fork coordinates (write target). */
  fork: ForkRef;
  /** The caller's rig handle. */
  rigHandle: RigHandle;
  /** Optional injectable now-source. Defaults to `() => new Date()`. */
  now?: () => Date;
  /** Optional injectable fetch implementation. Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Optional hooks (request/error logging). */
  hooks?: DoltFetchHooks;
};

/**
 * Standard envelope for op results. Mirrors the discriminated-union
 * shape used elsewhere in the cloud monorepo.
 */
export type WlResult<T> = { ok: true; data: T } | { ok: false; error: WlError };

/** Outcome of a mutation that writes (or no-ops) to a branch. */
export type MutationOutcome = {
  /** Branch the mutation targets. Empty string when auto-cleanup ran. */
  branchName: BranchName;
  /** True when the branch already represented the target state. */
  alreadyApplied: boolean;
  /** True when the post-mutation branch matched main and was deleted. */
  cleanedUp: boolean;
};

/** Outcome of `post` — also carries the generated wanted id. */
export type PostOutcome = MutationOutcome & {
  wantedId: string;
};

/** Outcome of `done` — carries the generated completion id. */
export type DoneOutcome = MutationOutcome & {
  completionId: string;
};

/** Outcome of `accept` — carries the generated stamp id. */
export type AcceptOutcome = MutationOutcome & {
  stampId: string;
};
