/**
 * Wanted-board ops — `@kilocode/wl-sdk` adapter (worker-bound layer).
 *
 * Thin wrappers over the inner functions in
 * `wanted-board-ops-sdk-inner.ts`. Each wrapper:
 *  1. Resolves DoltHub auth + fork coordinates via `loadSdkContext`.
 *  2. Calls the matching `*ViaSdk` inner function.
 *  3. Refreshes the WastelandDO's wanted-board cache and emits a
 *     billing meter event.
 *
 * Notable behaviour (see the inner module's docs for details):
 *  - `claim.pr_url` is produced by calling `wl.publish` after
 *    `wl.claim`; the SDK separates the two ops.
 *  - `direct` mode is silently downgraded to PR mode because the SDK
 *    has no upstream-direct write path.
 *  - `post` synthesizes a `w-<random>` id (the SDK does not own id
 *    generation).
 *  - `accept` reads the latest completion id off the user's branch
 *    because the SDK requires it as input.
 */

import { z } from 'zod';
import { readBranchHead } from '@kilocode/wl-sdk';
import { getWastelandDOStub } from '../dos/Wasteland.do';
import { deriveEncryptionKey, decryptToken } from '../util/crypto.util';
import { resolveSecret } from '../util/secret.util';
import { meterEvent } from '../util/billing.util';
import { fetchFreshDoltHubToken } from '../util/dolthub-token.util';
import * as doltApi from '../util/dolthub-api.util';
import { WantedBoardOpError } from './errors';
import {
  acceptViaSdk,
  browseViaSdk,
  claimViaSdk,
  closeViaSdk,
  doneViaSdk,
  editViaSdk,
  postViaSdk,
  rejectViaSdk,
  unclaimViaSdk,
  type SdkContext,
} from './wanted-board-ops-sdk-inner';

const PriorityEnum = z.enum(['low', 'medium', 'high', 'critical']);
const TypeEnum = z.enum(['feature', 'bug', 'docs', 'other']);

export async function loadSdkContext(
  env: Env,
  wastelandId: string,
  userId: string
): Promise<SdkContext & { doStub: ReturnType<typeof getWastelandDOStub> }> {
  const doStub = getWastelandDOStub(env, wastelandId);

  const config = await doStub.getConfig();
  if (!config?.dolthub_upstream) {
    throw new WantedBoardOpError(
      'Wasteland has no DoltHub upstream configured',
      'PRECONDITION_FAILED'
    );
  }

  const fresh = await fetchFreshDoltHubToken(env, { userId });
  const credential = await doStub.getCredential(userId);
  const isUpstreamAdmin = credential?.is_upstream_admin ?? false;

  const dolthubOrg =
    (fresh.status === 'ok' ? fresh.data.dolthubUsername : null) ?? credential?.dolthub_org ?? null;
  if (!dolthubOrg) {
    throw new WantedBoardOpError(
      'DoltHub username unknown — reconnect DoltHub in settings to refresh',
      'PRECONDITION_FAILED'
    );
  }

  const rigHandle = credential?.rig_handle ?? dolthubOrg.slice(0, 32);

  if (fresh.status === 'ok') {
    return {
      doStub,
      upstream: config.dolthub_upstream,
      forkOrg: dolthubOrg,
      rigHandle,
      token: fresh.data.token,
      isUpstreamAdmin,
    };
  }

  if (fresh.status === 'unavailable') {
    console.warn('[loadSdkContext] fresh DoltHub token unavailable, falling back', {
      wastelandId,
      userId,
      reason: fresh.reason,
    });
  }

  if (!credential) {
    throw new WantedBoardOpError(
      'No DoltHub credential stored — connect DoltHub in settings first',
      'PRECONDITION_FAILED'
    );
  }

  const rawKey = await resolveSecret(env.WASTELAND_ENCRYPTION_KEY);
  if (!rawKey) {
    throw new WantedBoardOpError('Encryption key unavailable', 'INTERNAL_SERVER_ERROR');
  }
  const cryptoKey = await deriveEncryptionKey(rawKey);
  const token = await decryptToken(credential.encrypted_token, cryptoKey);

  return {
    doStub,
    upstream: config.dolthub_upstream,
    forkOrg: dolthubOrg,
    rigHandle,
    token,
    isUpstreamAdmin,
  };
}

// ── Public ops ──────────────────────────────────────────────────────────

export async function browseWantedBoard(
  env: Env,
  wastelandId: string,
  userId: string
): Promise<Array<Record<string, unknown>>> {
  const ctx = await loadSdkContext(env, wastelandId, userId);
  return browseViaSdk(ctx);
}

export async function claimWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  itemId: string,
  // `direct` is accepted for API compatibility but silently ignored —
  // the SDK has no upstream-direct write path.
  _options?: { direct?: boolean }
): Promise<{ success: true; pr_url: string | null }> {
  const ctx = await loadSdkContext(env, wastelandId, userId);
  const result = await claimViaSdk(ctx, itemId);
  meterEvent(env, { event: 'billing.api_operation', userId, wastelandId, label: 'claim' });
  return result;
}

export async function unclaimWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  itemId: string,
  _options?: { direct?: boolean }
): Promise<{ success: true }> {
  const ctx = await loadSdkContext(env, wastelandId, userId);
  const result = await unclaimViaSdk(ctx, itemId);
  meterEvent(env, { event: 'billing.api_operation', userId, wastelandId, label: 'unclaim' });
  return result;
}

/**
 * All-in-one admin accept for a worker's in-review submission.
 *
 * The canonical `wl` CLI splits this into `wl accept-upstream` (writes
 * adoption + opens admin's PR) and a separate `wl merge` (lands the
 * admin's PR into main) with optional `wl reject-upstream` housekeeping
 * to close the worker's stale PR. In the cloud UI we collapse all of
 * this into a single Accept click — the admin fills in stamp metadata
 * once and the server runs the full chain:
 *
 *  1. `acceptViaSdk` writes the 5-statement `AcceptUpstreamDML` stack
 *     on `wl/<admin>/<itemId>` (the admin's adoption branch) and
 *     auto-publishes a fresh upstream PR.
 *  2. We merge the admin's adoption PR into upstream `main` so
 *     `wanted.status` flips to `completed` and the stamp lands
 *     on-chain. Synchronous merge surface today; async polling can
 *     come later if DoltHub's merge endpoint switches to operation
 *     name semantics for this call shape.
 *  3. We close the worker's original `wl done` PR (best-effort) so it
 *     doesn't linger in the inbox as a stale duplicate. A close
 *     failure does NOT fail the accept response: by this point the
 *     adoption has already merged.
 *
 * `submitterPullId`, `submitterRigHandle`, `submitterForkOwner`,
 * `completionId`, and `evidence` are the five pieces of context the
 * inbox classifier already has on each `work-submission` row;
 * threading them through avoids re-deriving them with another
 * cross-fork read.
 */
export async function acceptWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  input: {
    itemId: string;
    /** PR id of the worker's original `wl done` submission. */
    submitterPullId?: string;
    submitterRigHandle?: string;
    submitterForkOwner?: string;
    completionId?: string;
    evidence?: string;
    quality: 'excellent' | 'good' | 'fair' | 'poor';
    reliability?: 'excellent' | 'good' | 'fair' | 'poor';
    severity?: 'leaf' | 'branch' | 'root';
    skillTags?: readonly string[];
    message?: string;
    direct?: boolean;
  }
): Promise<{
  success: true;
  pr_url: string | null;
  pr_id: string | null;
  merged: boolean;
  closed_submitter_pr: boolean;
}> {
  const ctx = await loadSdkContext(env, wastelandId, userId);
  const accept = await acceptViaSdk(ctx, input);

  let merged = false;
  let closedSubmitterPR = false;

  // The merge + close housekeeping only runs for upstream admins.
  // Non-admin "Accept" callers can still write the adoption commit on
  // their fork (the SDK call above succeeds), but their token can't
  // merge the upstream PR — leave it open for an admin to land.
  if (ctx.isUpstreamAdmin && accept.pr_id) {
    try {
      const mergeResult = await doltApi.mergePull(ctx.upstream, ctx.token, accept.pr_id);
      // DoltHub returns `merged` for synchronous merges and `merging`
      // for async-with-operation_name flows; the unified merge endpoint
      // already kicks off the operation either way.
      merged = mergeResult.state === 'merged' || mergeResult.state === 'merging';
    } catch (err) {
      console.warn('[wanted-board-ops-sdk] merge of admin adoption PR failed', {
        wastelandId,
        itemId: input.itemId,
        adminPullId: accept.pr_id,
        err,
      });
    }
  }

  // Close the worker's original PR best-effort, only after we've at
  // least kicked off the adoption merge — otherwise the worker's
  // evidence disappears from the inbox while the upstream is still
  // in_review.
  if (ctx.isUpstreamAdmin && merged && input.submitterPullId) {
    try {
      await doltApi.closePull(ctx.upstream, ctx.token, input.submitterPullId);
      closedSubmitterPR = true;
    } catch (err) {
      console.warn('[wanted-board-ops-sdk] close of submitter PR failed', {
        wastelandId,
        itemId: input.itemId,
        submitterPullId: input.submitterPullId,
        err,
      });
    }
  }

  meterEvent(env, { event: 'billing.api_operation', userId, wastelandId, label: 'accept' });
  return {
    success: true,
    pr_url: accept.pr_url,
    pr_id: accept.pr_id,
    merged,
    closed_submitter_pr: closedSubmitterPR,
  };
}

export async function rejectWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  input: { itemId: string; reason: string; direct?: boolean }
): Promise<{ success: true }> {
  const ctx = await loadSdkContext(env, wastelandId, userId);
  const result = await rejectViaSdk(ctx, input);
  meterEvent(env, { event: 'billing.api_operation', userId, wastelandId, label: 'reject' });
  return result;
}

export async function closeWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  itemId: string,
  _options?: { direct?: boolean }
): Promise<{ success: true }> {
  const ctx = await loadSdkContext(env, wastelandId, userId);
  const result = await closeViaSdk(ctx, itemId);
  meterEvent(env, { event: 'billing.api_operation', userId, wastelandId, label: 'close' });
  return result;
}

export async function postWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  input: {
    title: string;
    description: string;
    priority?: z.infer<typeof PriorityEnum>;
    type?: z.infer<typeof TypeEnum>;
    direct?: boolean;
    publish?: boolean;
  }
): Promise<{ success: true; wantedId: string; pr_url: string | null }> {
  const ctx = await loadSdkContext(env, wastelandId, userId);
  const result = await postViaSdk(ctx, input);
  meterEvent(env, { event: 'billing.api_operation', userId, wastelandId, label: 'post' });
  return result;
}

export async function editWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  input: {
    itemId: string;
    title?: string;
    description?: string;
    priority?: z.infer<typeof PriorityEnum>;
    type?: z.infer<typeof TypeEnum>;
  }
): Promise<{ success: true; pr_url: string | null }> {
  const ctx = await loadSdkContext(env, wastelandId, userId);
  const result = await editViaSdk(ctx, input);
  meterEvent(env, { event: 'billing.api_operation', userId, wastelandId, label: 'edit' });
  return result;
}

export async function markWantedItemDone(
  env: Env,
  wastelandId: string,
  userId: string,
  input: { itemId: string; evidence: string; direct?: boolean }
): Promise<{ success: true; pr_url: string | null }> {
  const ctx = await loadSdkContext(env, wastelandId, userId);
  const result = await doneViaSdk(ctx, input);
  meterEvent(env, { event: 'billing.api_operation', userId, wastelandId, label: 'done' });
  return result;
}

/**
 * Read upstream main HEAD vs fork main HEAD without writing. UI uses
 * this to render the persistent "Sync fork" status indicator and
 * to compose the deep-link the button opens on click.
 *
 * DoltHub's hosted SQL API does not expose a programmatic fork-sync
 * (cross-repo `CALL DOLT_FETCH/MERGE` is blocked, and a fork owner
 * lacks write on the parent repo so they can't open a PR with
 * `from = upstream:main`). The supported path is the DoltHub web UI's
 * "Sync from upstream" button on the fork's `pulls/new` page, hence
 * the deep link.
 *
 * Best-effort: a null read on either side is treated as
 * "unknown, don't block" — the same decision rule as
 * `assertForkMainCurrent` (the SDK's mutation guard).
 */
export async function getForkCurrency(
  env: Env,
  wastelandId: string,
  userId: string
): Promise<{
  upstream: string;
  fork: string;
  upstreamHead: string | null;
  forkHead: string | null;
  isCurrent: boolean;
  syncUrl: string;
}> {
  const ctx = await loadSdkContext(env, wastelandId, userId);
  const upstreamParts = ctx.upstream.split('/');
  if (upstreamParts.length !== 2 || !upstreamParts[0] || !upstreamParts[1]) {
    throw new WantedBoardOpError(
      `Malformed upstream "${ctx.upstream}" on wasteland ${wastelandId}`,
      'INTERNAL_SERVER_ERROR'
    );
  }
  const upstreamOwner = upstreamParts[0];
  const upstreamDb = upstreamParts[1];
  // DoltHub doesn't allow renaming forks, so fork.db mirrors upstream.db.
  const forkOwner = ctx.forkOrg;
  const forkDb = upstreamDb;

  const auth = { token: ctx.token };
  const [upstreamHead, forkHead] = await Promise.all([
    readBranchHead({ auth, owner: upstreamOwner, db: upstreamDb, branch: 'main' }),
    readBranchHead({ auth, owner: forkOwner, db: forkDb, branch: 'main' }),
  ]);

  const isCurrent = upstreamHead === null || forkHead === null || upstreamHead === forkHead;

  // The DoltHub `pulls/new` page reads `fromBranchOwner`, `fromBranchRepo`,
  // `fromBranch`, and `toBranch` query params on the server (visible in
  // its `__NEXT_DATA__.pageProps.params`) and uses them to prefill the
  // PR form. Linking with these set drops the user on the form already
  // configured for an upstream→fork sync — they still have to manually
  // click "Create pull request" and merge it (DoltHub doesn't expose a
  // one-click "Sync from upstream" button), but they don't have to
  // reconfigure the from-repo or branches.
  const syncQs = new URLSearchParams({
    fromBranchOwner: upstreamOwner,
    fromBranchRepo: upstreamDb,
    fromBranch: 'main',
    toBranch: 'main',
  }).toString();

  return {
    upstream: `${upstreamOwner}/${upstreamDb}`,
    fork: `${forkOwner}/${forkDb}`,
    upstreamHead,
    forkHead,
    isCurrent,
    syncUrl: `https://www.dolthub.com/repositories/${encodeURIComponent(forkOwner)}/${encodeURIComponent(forkDb)}/pulls/new?${syncQs}`,
  };
}
