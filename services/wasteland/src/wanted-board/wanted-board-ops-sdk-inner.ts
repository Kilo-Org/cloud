/**
 * Inner SDK adapter functions, decoupled from the worker `Env` and
 * the WastelandDO. Each function takes a pre-resolved
 * {@link SdkContext} and an optional injected `fetch`, then drives
 * {@link WlClient} to produce the legacy tRPC return shape.
 *
 * This split exists so the unit tests in `wanted-board-ops-sdk.test.ts`
 * can exercise the SDK→legacy mapping at the fetch boundary without
 * touching `getWastelandDOStub` (which transitively imports
 * `cloudflare:workers` and breaks the Node-only vitest pool).
 *
 * The wrappers in `wanted-board-ops-sdk.ts` add credential resolution,
 * cache refresh, and metering on top of these.
 */

import { z } from 'zod';
import { WlClient, WlError, doltRead, type WlClientConfig } from '@kilocode/wl-sdk';
import { WantedBoardOpError } from './errors';
import { listMyForkBranchesViaSdk } from '../branch-ops/branch-ops-inner';

export type SdkContext = {
  upstream: string;
  forkOrg: string;
  rigHandle: string;
  token: string;
  isUpstreamAdmin: boolean;
};

function makeClient(ctx: SdkContext, fetchImpl?: typeof fetch): WlClient {
  const config: WlClientConfig = {
    upstream: ctx.upstream,
    forkOrg: ctx.forkOrg,
    rigHandle: ctx.rigHandle,
    token: ctx.token,
    fetch: fetchImpl,
  };
  return new WlClient(config);
}

/** Map any SDK error (or WlError) into a {@link WantedBoardOpError}. */
function wrapSdkError(err: unknown, label: string): WantedBoardOpError {
  if (err instanceof WantedBoardOpError) return err;
  if (err instanceof WlError) {
    const code =
      err.code === 'auth' || err.code === 'precondition'
        ? 'PRECONDITION_FAILED'
        : err.code === 'not_found'
          ? 'NOT_FOUND'
          : err.code === 'internal'
            ? 'INTERNAL_SERVER_ERROR'
            : 'UPSTREAM_ERROR';
    return new WantedBoardOpError(`${label} failed: ${err.message}`, code, err);
  }
  return new WantedBoardOpError(
    `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
    'UPSTREAM_ERROR',
    err
  );
}

const PriorityEnum = z.enum(['low', 'medium', 'high', 'critical']);
const TypeEnum = z.enum(['feature', 'bug', 'docs', 'other']);

const PRIORITY_TO_NUMBER: Record<z.infer<typeof PriorityEnum>, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

const QUALITY_TO_INT: Record<'excellent' | 'good' | 'fair' | 'poor', number> = {
  excellent: 5,
  good: 4,
  fair: 3,
  poor: 2,
};

function makeWantedId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `w-${hex}`;
}

function makeStampId(wantedId: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `s-${wantedId}-${hex}`;
}

/**
 * Read the latest completion `(id, evidence)` for a wanted item off
 * the `wl/<submitterRigHandle>/<itemId>` branch on the submitter's
 * fork.
 *
 * Used by `acceptViaSdk` because the underlying SDK requires both
 * fields to skip its own cross-fork read. The branch lives on the
 * submitter's fork (NOT the admin's), so `submitterForkOwner` is
 * required for cross-fork accept; falls back to `ctx.forkOrg` only
 * for legacy single-fork tests where admin and submitter share an
 * org.
 */
async function readLatestCompletion(
  ctx: SdkContext,
  wantedId: string,
  submitterRigHandle: string,
  submitterForkOwner: string | null,
  fetchImpl?: typeof fetch
): Promise<{ id: string; evidence: string | null } | null> {
  const escapedId = wantedId.replace(/'/g, "''").replace(/\\/g, '\\\\');
  const sql = `SELECT id, evidence FROM completions WHERE wanted_id = '${escapedId}' ORDER BY submitted_at DESC LIMIT 1`;
  const slash = ctx.upstream.indexOf('/');
  if (slash <= 0) return null;
  const upstreamDb = ctx.upstream.slice(slash + 1);
  const branchName = `wl/${submitterRigHandle}/${wantedId}`;
  try {
    const res = await doltRead({
      auth: { token: ctx.token },
      owner: submitterForkOwner ?? ctx.forkOrg,
      db: upstreamDb,
      ref: branchName,
      query: sql,
      fetch: fetchImpl,
    });
    if (res.rows.length === 0) return null;
    const parsed = z
      .object({ id: z.string(), evidence: z.string().nullable().optional() })
      .passthrough()
      .safeParse(res.rows[0]);
    if (!parsed.success) return null;
    return { id: parsed.data.id, evidence: parsed.data.evidence ?? null };
  } catch {
    return null;
  }
}

// ── Inner ops ────────────────────────────────────────────────────────────

export async function browseViaSdk(
  ctx: SdkContext,
  fetchImpl?: typeof fetch
): Promise<Array<Record<string, unknown>>> {
  const wl = makeClient(ctx, fetchImpl);
  let entries;
  try {
    entries = await wl.browse();
  } catch (err) {
    throw wrapSdkError(err, 'Browse');
  }
  return entries.map(entry => {
    // Prefer the row the SDK marked as authoritative (`entry.source`).
    // The SDK reconciles fork-vs-upstream by comparing `updated_at` so
    // a stale fork branch (e.g. an admin merged the user's `wl done`
    // upstream and the local `wl/<rig>/<id>` branch still shows
    // `in_review`) doesn't shadow the freshly-completed upstream row.
    const row = entry.source === 'fork' ? (entry.fork?.row ?? entry.upstream) : entry.upstream;
    if (row === null || row === undefined) return { id: entry.wantedId };
    return { ...row };
  });
}

export async function claimViaSdk(
  ctx: SdkContext,
  itemId: string,
  fetchImpl?: typeof fetch
): Promise<{ success: true; pr_url: string | null }> {
  const wl = makeClient(ctx, fetchImpl);
  let prUrl: string | null = null;
  try {
    const outcome = await wl.claim(itemId);
    if (!outcome.cleanedUp) {
      try {
        const pub = await wl.publish(itemId);
        prUrl = pub.prUrl;
      } catch {
        console.warn('[wanted-board-ops-sdk] publish after claim failed', { itemId });
      }
    }
  } catch (err) {
    throw wrapSdkError(err, 'Claim');
  }
  return { success: true, pr_url: prUrl };
}

export async function unclaimViaSdk(
  ctx: SdkContext,
  itemId: string,
  fetchImpl?: typeof fetch
): Promise<{ success: true }> {
  const wl = makeClient(ctx, fetchImpl);
  try {
    await wl.unclaim(itemId);
  } catch (err) {
    throw wrapSdkError(err, 'Unclaim');
  }
  return { success: true };
}

/**
 * Adopt a worker's in-review upstream PR and issue a reputation stamp.
 *
 * Mirrors the canonical `wl accept-upstream` flow:
 *  1. Load the worker's completion id off `wl/<submitter>/<itemId>` on
 *     the submitter's fork (the wanted-board adapter passes this in
 *     directly when known, since the inbox classifier has already
 *     fetched it).
 *  2. Run the 5-statement `AcceptUpstreamDML` stack on the admin's
 *     `wl/<admin>/<itemId>` branch (DELETE/INSERT completion, UPDATE
 *     wanted to completed, INSERT stamp, UPDATE completion with
 *     stamp_id).
 *  3. Auto-publish the admin's adoption PR for upstream merge. The
 *     wrapper in `wanted-board-ops-sdk.ts` then merges that PR and
 *     closes the worker's original PR — the all-in-one accept UX.
 *
 * Returns the `pr_url` of the admin's adoption PR so callers can
 * follow up with merge / housekeeping.
 */
export async function acceptViaSdk(
  ctx: SdkContext,
  input: {
    itemId: string;
    submitterRigHandle?: string;
    /**
     * DoltHub owner of the submitter's fork. Required when admin and
     * submitter are in different DoltHub orgs (the common cross-fork
     * case). Falls back to `ctx.forkOrg` for the legacy single-fork
     * case.
     */
    submitterForkOwner?: string;
    /**
     * The completion id from the worker's branch. The inbox classifier
     * already has this (`work-submission.completion_id`); pass it
     * through to skip the extra cross-fork read.
     */
    completionId?: string;
    /**
     * Evidence URL the worker submitted with `wl done`. Skips the
     * cross-fork read of `completions.evidence` when known.
     */
    evidence?: string;
    quality: 'excellent' | 'good' | 'fair' | 'poor';
    reliability?: 'excellent' | 'good' | 'fair' | 'poor';
    severity?: 'leaf' | 'branch' | 'root';
    skillTags?: readonly string[];
    message?: string;
  },
  fetchImpl?: typeof fetch
): Promise<{ success: true; pr_url: string | null; pr_id: string | null }> {
  const submitterRigHandle =
    input.submitterRigHandle ?? (await resolveSubmitterRig(ctx, input.itemId, fetchImpl));
  if (!submitterRigHandle) {
    throw new WantedBoardOpError(
      'Accept failed: no in-review submitter found',
      'PRECONDITION_FAILED'
    );
  }
  if (submitterRigHandle === ctx.rigHandle) {
    throw new WantedBoardOpError(
      'Accept failed: cannot issue a stamp to yourself; close the item instead',
      'PRECONDITION_FAILED'
    );
  }

  let completionId = input.completionId;
  let evidence = input.evidence;
  if (!completionId || !evidence) {
    const found = await readLatestCompletion(
      ctx,
      input.itemId,
      submitterRigHandle,
      input.submitterForkOwner ?? null,
      fetchImpl
    );
    if (!found) {
      throw new WantedBoardOpError(
        `Accept failed: no completion found on branch wl/${submitterRigHandle}/${input.itemId}`,
        'PRECONDITION_FAILED'
      );
    }
    completionId = completionId ?? found.id;
    evidence = evidence ?? found.evidence ?? undefined;
  }
  if (!evidence) {
    throw new WantedBoardOpError(
      `Accept failed: no evidence recorded on branch wl/${submitterRigHandle}/${input.itemId}`,
      'PRECONDITION_FAILED'
    );
  }
  const wl = makeClient(ctx, fetchImpl);
  let prUrl: string | null = null;
  let prId: string | null = null;
  try {
    await wl.acceptUpstream(input.itemId, {
      submitterRigHandle,
      submitterForkOwner: input.submitterForkOwner,
      completionId,
      evidence,
      stamp: {
        id: makeStampId(input.itemId),
        subject: submitterRigHandle,
        quality: QUALITY_TO_INT[input.quality],
        reliability: QUALITY_TO_INT[input.reliability ?? input.quality],
        severity: input.severity ?? 'leaf',
        skillTags: input.skillTags,
        message: input.message,
      },
    });
    const pub = await wl.publish(input.itemId);
    prUrl = pub.prUrl;
    prId = pub.prId;
  } catch (err) {
    throw wrapSdkError(err, 'Accept');
  }
  return { success: true, pr_url: prUrl, pr_id: prId };
}

async function resolveSubmitterRig(
  ctx: SdkContext,
  itemId: string,
  fetchImpl?: typeof fetch
): Promise<string | null> {
  const branches = await listMyForkBranchesViaSdk(ctx, fetchImpl);
  const branch = branches.find(
    b => b.wantedId === itemId && b.wantedStatusOnBranch === 'in_review'
  );
  return branch?.branchName.split('/')[1] ?? null;
}

export async function rejectViaSdk(
  ctx: SdkContext,
  input: { itemId: string; reason: string },
  fetchImpl?: typeof fetch
): Promise<{ success: true }> {
  const wl = makeClient(ctx, fetchImpl);
  try {
    await wl.reject(input.itemId, { reason: input.reason });
  } catch (err) {
    throw wrapSdkError(err, 'Reject');
  }
  return { success: true };
}

export async function closeViaSdk(
  ctx: SdkContext,
  itemId: string,
  fetchImpl?: typeof fetch
): Promise<{ success: true }> {
  const wl = makeClient(ctx, fetchImpl);
  try {
    await wl.close(itemId);
  } catch (err) {
    throw wrapSdkError(err, 'Close');
  }
  return { success: true };
}

export async function postViaSdk(
  ctx: SdkContext,
  input: {
    title: string;
    description: string;
    priority?: z.infer<typeof PriorityEnum>;
    type?: z.infer<typeof TypeEnum>;
    publish?: boolean;
  },
  fetchImpl?: typeof fetch
): Promise<{ success: true; wantedId: string; pr_url: string | null }> {
  const wl = makeClient(ctx, fetchImpl);
  const wantedId = makeWantedId();
  let prUrl: string | null = null;
  try {
    await wl.post({
      wantedId,
      title: input.title,
      description: input.description,
      type: input.type,
      priority:
        input.priority !== undefined
          ? PRIORITY_TO_NUMBER[input.priority]
          : PRIORITY_TO_NUMBER.medium,
    });
    if (input.publish === true) {
      const pub = await wl.publish(wantedId);
      prUrl = pub.prUrl;
    }
  } catch (err) {
    throw wrapSdkError(err, 'Post');
  }
  return { success: true, wantedId, pr_url: prUrl };
}

export async function editViaSdk(
  ctx: SdkContext,
  input: {
    itemId: string;
    title?: string;
    description?: string;
    priority?: z.infer<typeof PriorityEnum>;
    type?: z.infer<typeof TypeEnum>;
  },
  fetchImpl?: typeof fetch
): Promise<{ success: true; pr_url: string | null }> {
  const wl = makeClient(ctx, fetchImpl);
  let prUrl: string | null = null;
  try {
    await wl.edit({
      wantedId: input.itemId,
      title: input.title,
      description: input.description,
      type: input.type,
      priority: input.priority !== undefined ? PRIORITY_TO_NUMBER[input.priority] : undefined,
    });
    try {
      const pub = await wl.publish(input.itemId);
      prUrl = pub.prUrl;
    } catch {
      console.warn('[wanted-board-ops-sdk] publish after edit failed', { itemId: input.itemId });
    }
  } catch (err) {
    throw wrapSdkError(err, 'Edit');
  }
  return { success: true, pr_url: prUrl };
}

/**
 * Mark a wanted item as done with evidence, then auto-publish the
 * fork branch as an upstream PR so the maintainer can review without
 * the caller having to take a second action.
 *
 * Mirrors the canonical `wl` CLI: `Client.mutatePR` in
 * `wasteland/internal/sdk/mutate.go` auto-creates a PR after the
 * mutation when the branch survives auto-cleanup and no PR exists
 * yet. The cloud SDK splits write/publish into two ops, so the
 * adapter chains them here — same pattern as `claimViaSdk` and
 * `editViaSdk`.
 *
 * Publish failures are demoted to warnings so the upstream branch
 * write (the source of truth) is not lost when only the PR-creation
 * call fails. Callers can retry publish from the workshop UI.
 */
export async function doneViaSdk(
  ctx: SdkContext,
  input: { itemId: string; evidence: string },
  fetchImpl?: typeof fetch
): Promise<{ success: true; pr_url: string | null }> {
  const wl = makeClient(ctx, fetchImpl);
  let prUrl: string | null = null;
  try {
    await wl.done(input.itemId, { evidence: input.evidence });
    try {
      const pub = await wl.publish(input.itemId);
      prUrl = pub.prUrl;
    } catch (err) {
      console.warn('[wanted-board-ops-sdk] publish after done failed', {
        itemId: input.itemId,
        err,
      });
    }
  } catch (err) {
    throw wrapSdkError(err, 'Mark done');
  }
  return { success: true, pr_url: prUrl };
}
