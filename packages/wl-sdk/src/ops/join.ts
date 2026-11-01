/**
 * `join` — the connect ceremony for a new rig.
 *
 * Mirrors `Service.Join` (`wasteland/internal/federation/federation.go:69`)
 * and `runJoinRemote` in `wasteland/cmd/wl/cmd_join.go`.
 *
 * The wl-sdk variant is REST-only: there is no local clone, so the
 * fork-then-clone-then-push path of the Go reference becomes
 * fork-then-write-via-DoltHub. Steps:
 *
 *   1. Fork upstream `<owner>/<repo>` to user's `<dolthubOrg>/<repo>`.
 *      Idempotent — DoltHub returns "already exists" on a re-fork,
 *      which `forkDatabase` resolves as `created: false`.
 *   2. If the rig is already present on upstream `main`, return without
 *      creating a registration branch or PR — but only when the
 *      registered row's `dolthub_org` is the caller's own org and
 *      DoltHub backs that org for this caller: the fork was just
 *      created under it, it is the username behind the token, or
 *      `orgProven` records an org an earlier authorized write
 *      established. A handle registered to another org is refused
 *      (`precondition`) and an unreadable `rigs` table is an upstream
 *      error, so the caller can never adopt a rig identity they do not
 *      own.
 *   3. If an open registration PR already exists for this rig, return
 *      it without writing another registration commit.
 *   4. Run the registration INSERT through the DoltHub write API,
 *      targeting `wl/register/<handle>` so the registration lands on
 *      a branch and a maintainer can review it before merging into
 *      `rigs` on upstream.
 *   5. Open a PR from the fork's registration branch to upstream
 *      `main`. We don't auto-close the PR if registration is later
 *      rerun — `ON DUPLICATE KEY UPDATE` makes the INSERT idempotent
 *      anyway, and the upstream maintainer is the one who decides.
 */

import { forkDatabase } from '../dolthub/database';
import { doltRead } from '../dolthub/read';
import { doltWrite } from '../dolthub/write';
import { createPull, listPulls } from '../dolthub/pulls';
import { buildRegistrationDML } from '../commons/registration';
import { escapeSqlString } from '../commons/escape';
import { getAuthenticatedUsername } from '../dolthub/user';
import { makeRegisterBranch } from './branch';
import { isSameDolthubOrg, rigHandleFormatError } from './rig-handle';
import { WlDoltHubError, type DoltHubAuth, type DoltFetchHooks } from '../dolthub/api';
import type { RigHandle, WastelandRef, WlResult } from './types';
import { WlError } from './types';
import { DOLTHUB_WEB_BASE } from '../dolthub/api';

export type JoinOptions = {
  auth: DoltHubAuth;
  upstream: WastelandRef;
  /** DoltHub username/org under which the fork lives. */
  dolthubOrg: string;
  /** Rig handle to register. */
  rigHandle: RigHandle;
  /** Human-readable name for the rig. */
  displayName: string;
  /** Email used to seed `hop_uri` and `owner_email`. */
  ownerEmail: string;
  /** wl-sdk / runtime version string. */
  version: string;
  /** Polling timeout for fork creation. Defaults to 2 minutes. */
  forkTimeoutMs?: number;
  /** Retry timeout for registration writes while a fresh fork settles. */
  registrationWriteTimeoutMs?: number;
  /** Initial retry backoff for registration writes. */
  registrationWriteInitialBackoffMs?: number;
  /** Inject sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Set only by a caller that holds a server-side record proving this
   * token's account may act for `dolthubOrg`: the org was established
   * for this identity by an earlier DoltHub-authorized write (a fork
   * created under it, a registration write into its fork, or a
   * repository created under it). Without it, a success path that hands
   * the caller a rig identity must re-prove the org on every call,
   * which a DoltHub org (as opposed to the token's own username) can
   * never satisfy through the API.
   */
  orgProven?: boolean;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

export type JoinResult = {
  /** DoltHub web URL for the user's fork. */
  forkUrl: string;
  /** PR URL on upstream — empty string if creation failed best-effort. */
  registrationPrUrl: string;
  /** Pull id on upstream — empty string if creation failed best-effort. */
  registrationPullId: string;
  /** The branch on the fork holding the rig registration. */
  branchName: string;
  /** True when this call did the actual fork; false when fork already existed. */
  forkCreated: boolean;
};

export async function join(opts: JoinOptions): Promise<WlResult<JoinResult>> {
  try {
    const handleError = rigHandleFormatError(opts.rigHandle);
    if (handleError !== null) {
      return { ok: false, error: new WlError(handleError, 'precondition') };
    }

    // Step 1: fork upstream → user's org.
    const forkResult = await forkDatabase({
      auth: opts.auth,
      fromOwner: opts.upstream.owner,
      fromDb: opts.upstream.db,
      toOwner: opts.dolthubOrg,
      timeoutMs: opts.forkTimeoutMs,
      sleep: opts.sleep,
      fetch: opts.fetch,
      hooks: opts.hooks,
    });

    const branchName = makeRegisterBranch(opts.rigHandle);
    const forkUrl = `${DOLTHUB_WEB_BASE}/repositories/${encodeURIComponent(forkResult.owner)}/${encodeURIComponent(forkResult.db)}`;

    // Step 2: if the rig is already on upstream main, there is nothing
    // to register and no PR should be opened — but the caller may only
    // take the handle as their identity when the registered row belongs
    // to their own DoltHub org.
    const registration = await findRegisteredRig(opts);
    if (registration.status === 'unknown') {
      return {
        ok: false,
        error: new WlError(
          'Could not verify rig ownership on the upstream — retry the join',
          'upstream',
          registration.cause
        ),
      };
    }
    if (registration.status === 'found') {
      if (!isSameDolthubOrg(registration.dolthubOrg, opts.dolthubOrg)) {
        return {
          ok: false,
          error: new WlError(
            `Rig handle "${opts.rigHandle}" is registered to another DoltHub org — choose your own handle and retry`,
            'precondition'
          ),
        };
      }
      // The registered org matched, but the org itself can be asserted by
      // the caller. Accept it only when DoltHub proved this token may act
      // for that org: the fork was just created under it, or it is the
      // username the token belongs to.
      const orgError = await orgProofError(opts, forkResult.created);
      if (orgError !== null) {
        return { ok: false, error: orgError };
      }
      return {
        ok: true,
        data: {
          forkUrl,
          branchName,
          registrationPrUrl: '',
          registrationPullId: '',
          forkCreated: forkResult.created,
        },
      };
    }

    // Step 3: if a registration PR already exists for this branch,
    // do not write another registration commit. This is also a success
    // path that hands the caller the handle as their identity and skips
    // the registration write, so the org has to be backed the same way.
    const existing = await findOpenRegistrationPr(opts, branchName);
    if (existing !== null) {
      const prOrgError = await orgProofError(opts, forkResult.created);
      if (prOrgError !== null) {
        return { ok: false, error: prOrgError };
      }
      return {
        ok: true,
        data: {
          forkUrl,
          branchName,
          registrationPrUrl: buildPullWebUrl(opts.upstream, existing),
          registrationPullId: existing,
          forkCreated: forkResult.created,
        },
      };
    }

    // Step 4: write registration onto wl/register/<handle> (creates
    // the branch from main on the first call).
    const dml = buildRegistrationDML({
      handle: opts.rigHandle,
      dolthubOrg: opts.dolthubOrg,
      displayName: opts.displayName,
      ownerEmail: opts.ownerEmail,
      version: opts.version,
    });
    try {
      await writeRegistrationWithRetry({
        join: opts,
        forkOwner: forkResult.owner,
        forkDb: forkResult.db,
        branchName,
        dml,
      });
    } catch (err) {
      throw new WlError('Registration write failed', 'upstream', err);
    }

    // Step 5: open a PR.
    try {
      const pr = await createPull({
        auth: opts.auth,
        owner: opts.upstream.owner,
        db: opts.upstream.db,
        title: `Register rig: ${opts.rigHandle}`,
        description: `Register rig **${opts.rigHandle}** (${opts.displayName}) in the commons.`,
        fromOwner: opts.dolthubOrg,
        fromDb: forkResult.db,
        fromBranch: branchName,
        toBranch: 'main',
        fetch: opts.fetch,
        hooks: opts.hooks,
      });
      return {
        ok: true,
        data: {
          forkUrl,
          branchName,
          registrationPrUrl: buildPullWebUrl(opts.upstream, pr.pullId),
          registrationPullId: pr.pullId,
          forkCreated: forkResult.created,
        },
      };
    } catch (err) {
      // PR creation is best-effort — the registration write already
      // landed. Return success with empty PR fields so the caller
      // can retry the publish step on its own if desired.
      void err;
      return {
        ok: true,
        data: {
          forkUrl,
          branchName,
          registrationPrUrl: '',
          registrationPullId: '',
          forkCreated: forkResult.created,
        },
      };
    }
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('join failed', 'upstream', err) };
  }
}

async function writeRegistrationWithRetry(opts: {
  join: JoinOptions;
  forkOwner: string;
  forkDb: string;
  branchName: string;
  dml: string;
}): Promise<void> {
  const timeoutMs = opts.join.registrationWriteTimeoutMs ?? 10_000;
  const initialBackoffMs = opts.join.registrationWriteInitialBackoffMs ?? 500;
  const sleep =
    opts.join.sleep ?? ((ms: number) => new Promise(resolve => setTimeout(resolve, ms)));
  const startedAt = Date.now();
  let attempt = 0;
  let lastError: unknown;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      await doltWrite({
        auth: opts.join.auth,
        owner: opts.forkOwner,
        db: opts.forkDb,
        fromBranch: 'main',
        toBranch: opts.branchName,
        query: `${opts.dml}; -- wl register: ${opts.join.rigHandle}`,
        fetch: opts.join.fetch,
        hooks: opts.join.hooks,
      });
      return;
    } catch (err) {
      lastError = err;
      if (!isTransientRegistrationWriteError(err)) throw err;
    }

    attempt += 1;
    await sleep(Math.min(initialBackoffMs * attempt, 2_000));
  }

  throw lastError;
}

function isTransientRegistrationWriteError(err: unknown): boolean {
  if (!(err instanceof WlDoltHubError)) return false;
  if (err.status === 404 || err.status === 409 || err.status === 429 || err.status >= 500) {
    return true;
  }
  const bodyText = typeof err.body === 'string' ? err.body : JSON.stringify(err.body);
  return /branch|database|repo|not found|not ready|already exists|timeout|temporar/i.test(bodyText);
}

type RegisteredRig =
  | { status: 'absent' }
  | { status: 'found'; dolthubOrg: string | null }
  | { status: 'unknown'; cause: unknown };

/**
 * Read the upstream `rigs` row for a handle, including the DoltHub org
 * that registered it. The org is what proves the caller may operate
 * under this handle, so a failed read is reported separately instead of
 * being treated as "not registered".
 */
async function findRegisteredRig(opts: JoinOptions): Promise<RegisteredRig> {
  try {
    const res = await doltRead({
      auth: opts.auth,
      owner: opts.upstream.owner,
      db: opts.upstream.db,
      query: `SELECT handle, dolthub_org FROM rigs WHERE handle = '${escapeSqlString(opts.rigHandle)}' LIMIT 1`,
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
    const row = res.rows[0];
    if (row === undefined) return { status: 'absent' };
    return { status: 'found', dolthubOrg: readDolthubOrg(row) };
  } catch (cause) {
    return { status: 'unknown', cause };
  }
}

type TokenOwner = { status: 'resolved'; username: string } | { status: 'unknown'; cause: unknown };

/**
 * Decide whether DoltHub backs the claimed org for this token, for a
 * success path that hands the caller a rig identity without another
 * DoltHub-authorized write. A fork the join just created under the org
 * is proof in itself; so is an org the caller's own record already
 * established through an earlier authorized write. Otherwise the org
 * must be the username the token belongs to. Returns the error to
 * report, or null when the org is backed.
 */
async function orgProofError(opts: JoinOptions, forkCreated: boolean): Promise<WlError | null> {
  if (forkCreated) return null;
  if (opts.orgProven === true) return null;
  const owner = await resolveTokenOwner(opts);
  if (owner.status === 'unknown') {
    return new WlError(
      'Could not resolve the DoltHub account for this token — retry the join',
      'upstream',
      owner.cause
    );
  }
  if (isSameDolthubOrg(owner.username, opts.dolthubOrg)) return null;
  return new WlError(
    `Could not confirm that DoltHub org "${opts.dolthubOrg}" belongs to you — join with a handle registered under your DoltHub username, or reconnect DoltHub and retry`,
    'precondition'
  );
}

/**
 * Ask DoltHub which account the token belongs to. Kept separate from the
 * org comparison so a failed lookup is reported as an upstream problem
 * rather than being read as "the org is not yours".
 */
async function resolveTokenOwner(opts: JoinOptions): Promise<TokenOwner> {
  try {
    const username = await getAuthenticatedUsername({
      auth: opts.auth,
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
    return { status: 'resolved', username };
  } catch (cause) {
    return { status: 'unknown', cause };
  }
}

function readDolthubOrg(row: unknown): string | null {
  if (typeof row !== 'object' || row === null) return null;
  const value = (row as Record<string, unknown>).dolthub_org;
  return typeof value === 'string' ? value : null;
}

async function findOpenRegistrationPr(
  opts: JoinOptions,
  branchName: string
): Promise<string | null> {
  try {
    const pulls = await listPulls({
      auth: opts.auth,
      owner: opts.upstream.owner,
      db: opts.upstream.db,
      state: 'open',
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
    // The list shape doesn't include from-branch; in practice
    // matchers compare the title, which is a stable
    // `Register rig: <handle>` string. That's a heuristic — for a
    // strict match the caller can use `getPull` per id, but at the
    // join call site this is good enough.
    const target = `Register rig: ${opts.rigHandle}`;
    const match = pulls.find(p => p.title === target);
    return match ? match.pull_id : null;
  } catch {
    void branchName;
    return null;
  }
}

function buildPullWebUrl(upstream: WastelandRef, pullId: string): string {
  return `${DOLTHUB_WEB_BASE}/repositories/${encodeURIComponent(upstream.owner)}/${encodeURIComponent(upstream.db)}/pulls/${encodeURIComponent(pullId)}`;
}
