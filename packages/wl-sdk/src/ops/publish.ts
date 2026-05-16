/**
 * `publish` — open a pull request from a `wl/<rig>/<id>` branch on the
 * fork to the upstream `main`.
 *
 * Mirrors `Client.SubmitPR` (`wasteland/internal/sdk/branches.go:91`)
 * and the `c.CreatePR` hook called from `mutatePR` after auto-cleanup.
 *
 * The Go SDK has an "auto-PR" mode where a successful mutation also
 * opens the PR; the wl-sdk separates this out into an explicit op so
 * callers (web, CLI) can decide when to publish independent of when
 * the mutation lands.
 *
 * Idempotent: if an open PR already targets `main` from this branch,
 * returns its url instead of creating a duplicate.
 */

import { createPull, getPull, listPulls } from '../dolthub/pulls';
import { readWantedRowAt } from './state';
import { makeWlBranch } from './branch';
import type { DoltHubAuth, DoltFetchHooks } from '../dolthub/api';
import type { RigHandle, WastelandRef, WlResult } from './types';
import { WlError } from './types';
import { DOLTHUB_WEB_BASE } from '../dolthub/api';

export type PublishOptions = {
  auth: DoltHubAuth;
  upstream: WastelandRef;
  fork: { forkOwner: string; forkDb: string };
  rigHandle: RigHandle;
  wantedId: string;
  /** Override the title; defaults to "wl: <wanted title> [<id>]". */
  title?: string;
  /** Override the description. */
  description?: string;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

export type PublishResult = {
  prUrl: string;
  pullId: string;
  /** True when this call created the PR; false when an open one already existed. */
  created: boolean;
};

export async function publish(opts: PublishOptions): Promise<WlResult<PublishResult>> {
  const branchName = makeWlBranch(opts.rigHandle, opts.wantedId);

  try {
    // Idempotency: existing open PR from this branch?
    const existing = await findOpenPullForBranch(opts, branchName);
    if (existing !== null) {
      return {
        ok: true,
        data: {
          prUrl: buildPullWebUrl(opts.upstream, existing),
          pullId: existing,
          created: false,
        },
      };
    }

    // Title fallback: read the branch's wanted row to compose a
    // human-readable title. If reads fail, fall back to a stable
    // fallback so the op still succeeds.
    let title = opts.title;
    if (!title) {
      const row = await readWantedRowAt({
        auth: opts.auth,
        owner: opts.fork.forkOwner,
        db: opts.fork.forkDb,
        ref: branchName,
        wantedId: opts.wantedId,
        fetch: opts.fetch,
        hooks: opts.hooks,
      });
      title = row?.title ? `wl: ${row.title} [${opts.wantedId}]` : `wl: ${opts.wantedId}`;
    }

    const pr = await createPull({
      auth: opts.auth,
      owner: opts.upstream.owner,
      db: opts.upstream.db,
      title,
      description: opts.description ?? '',
      fromOwner: opts.fork.forkOwner,
      fromDb: opts.fork.forkDb,
      fromBranch: branchName,
      toBranch: 'main',
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
    return {
      ok: true,
      data: {
        prUrl: buildPullWebUrl(opts.upstream, pr.pullId),
        pullId: pr.pullId,
        created: true,
      },
    };
  } catch (err) {
    if (err instanceof WlError) return { ok: false, error: err };
    return { ok: false, error: new WlError('publish failed', 'upstream', err) };
  }
}

/**
 * Find an open PR matching `<fork.owner>/<fork.db>:<branch>` →
 * `<upstream.owner>/<upstream.db>:main` by listing open pulls and
 * checking each one's detail (the list summary does not include
 * from-branch). Returns the pull id on a match, else `null`.
 */
async function findOpenPullForBranch(
  opts: PublishOptions,
  branchName: string
): Promise<string | null> {
  let pulls;
  try {
    pulls = await listPulls({
      auth: opts.auth,
      owner: opts.upstream.owner,
      db: opts.upstream.db,
      state: 'open',
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
  } catch {
    return null;
  }

  for (const summary of pulls) {
    try {
      const detail = await getPull({
        auth: opts.auth,
        owner: opts.upstream.owner,
        db: opts.upstream.db,
        pullId: summary.pull_id,
        fetch: opts.fetch,
        hooks: opts.hooks,
      });
      if (
        detail.from_branch_name === branchName &&
        detail.from_branch_owner_name === opts.fork.forkOwner &&
        (detail.to_branch_name === 'main' || detail.to_branch_name === null)
      ) {
        return detail.pull_id;
      }
    } catch {
      // Skip — DoltHub occasionally fails per-PR detail; the
      // fall-through path will create a new PR (and DoltHub will
      // reject the dup, surfacing as upstream error).
    }
  }
  return null;
}

function buildPullWebUrl(upstream: WastelandRef, pullId: string): string {
  return `${DOLTHUB_WEB_BASE}/repositories/${encodeURIComponent(upstream.owner)}/${encodeURIComponent(upstream.db)}/pulls/${encodeURIComponent(pullId)}`;
}
