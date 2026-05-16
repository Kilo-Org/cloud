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
 *   2. Run the registration INSERT through the DoltHub write API,
 *      targeting `wl/register/<handle>` so the registration lands on
 *      a branch and a maintainer can review it before merging into
 *      `rigs` on upstream.
 *   3. Open a PR from the fork's registration branch to upstream
 *      `main`. We don't auto-close the PR if registration is later
 *      rerun — `ON DUPLICATE KEY UPDATE` makes the INSERT idempotent
 *      anyway, and the upstream maintainer is the one who decides.
 */

import { forkDatabase } from '../dolthub/database';
import { doltWrite } from '../dolthub/write';
import { createPull, listPulls } from '../dolthub/pulls';
import { buildRegistrationDML } from '../commons/registration';
import { makeRegisterBranch } from './branch';
import type { DoltHubAuth, DoltFetchHooks } from '../dolthub/api';
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
  /** Inject sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
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

    // Step 2: write registration onto wl/register/<handle> (creates
    // the branch from main on the first call).
    const dml = buildRegistrationDML({
      handle: opts.rigHandle,
      dolthubOrg: opts.dolthubOrg,
      displayName: opts.displayName,
      ownerEmail: opts.ownerEmail,
      version: opts.version,
    });
    try {
      await doltWrite({
        auth: opts.auth,
        owner: forkResult.owner,
        db: forkResult.db,
        fromBranch: 'main',
        toBranch: branchName,
        query: `${dml}; -- wl register: ${opts.rigHandle}`,
        fetch: opts.fetch,
        hooks: opts.hooks,
      });
    } catch (err) {
      throw new WlError('Registration write failed', 'upstream', err);
    }

    const forkUrl = `${DOLTHUB_WEB_BASE}/repositories/${encodeURIComponent(forkResult.owner)}/${encodeURIComponent(forkResult.db)}`;

    // Step 3: open a PR. If a registration PR already exists for
    // this branch, return its id rather than opening another.
    const existing = await findOpenRegistrationPr(opts, branchName);
    if (existing !== null) {
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
