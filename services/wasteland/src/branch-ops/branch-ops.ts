/**
 * Branch & PR ops for the user's fork — the workshop and pulls views.
 *
 * Worker-bound layer over the inner functions in
 * `branch-ops-inner.ts`. Each wrapper:
 *  1. Resolves DoltHub auth + fork coordinates via the local
 *     `loadContext` helper.
 *  2. Calls the matching `*ViaSdk` inner function.
 *  3. Refreshes the WastelandDO's wanted-board cache (where needed)
 *     and emits a billing meter event.
 *
 *   - listMyForkBranches — enumerate `wl/<any-rig>/<wantedId>` branches on the fork,
 *     cross-referenced with each item's status on `main` and on the
 *     branch tip, plus an open-PR flag. Powers the M2.3 fork page.
 *   - publishBranch       — open or update a PR for a branch (idempotent).
 *   - discardBranch       — delete the branch (idempotent on 404).
 *   - listMyPulls         — list the user's PRs against the upstream.
 */

import { WantedBoardOpError } from '../wanted-board/errors';
import { getWastelandDOStub } from '../dos/Wasteland.do';
import { deriveEncryptionKey, decryptToken } from '../util/crypto.util';
import { resolveSecret } from '../util/secret.util';
import { fetchFreshDoltHubToken } from '../util/dolthub-token.util';
import { meterEvent } from '../util/billing.util';
import {
  discardBranchViaSdk,
  listMyForkBranchesViaSdk,
  listMyPullsViaSdk,
  publishBranchViaSdk,
  type BranchOpsInnerContext,
  type ForkBranchEntry,
  type MyPullEntry,
} from './branch-ops-inner';

export type {
  BranchDivergence,
  BranchOpsInnerContext,
  BranchWantedStatus,
  ForkBranchEntry,
  MyPullEntry,
} from './branch-ops-inner';

// ── Context resolution ───────────────────────────────────────────────────

/**
 * The inner context plus the WastelandDO stub that the worker-bound
 * wrappers need to refresh the wanted-board cache and meter billing.
 *
 * Mirrors `loadSdkContext` from `wanted-board-ops-sdk.ts`. We duplicate
 * intentionally to keep `wanted-board-ops-sdk.ts` free of
 * cross-imports.
 */
type BranchOpsContext = BranchOpsInnerContext & {
  doStub: ReturnType<typeof getWastelandDOStub>;
};

async function loadContext(
  env: Env,
  wastelandId: string,
  userId: string
): Promise<BranchOpsContext> {
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
    };
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
  };
}

// ── Worker-bound public ops ─────────────────────────────────────────────

export async function listMyForkBranches(
  env: Env,
  wastelandId: string,
  userId: string
): Promise<ForkBranchEntry[]> {
  const ctx = await loadContext(env, wastelandId, userId);
  return listMyForkBranchesViaSdk(ctx);
}

export async function publishBranch(
  env: Env,
  wastelandId: string,
  userId: string,
  wantedId: string
): Promise<{ prUrl: string; prId: string }> {
  const ctx = await loadContext(env, wastelandId, userId);
  const result = await publishBranchViaSdk(ctx, wantedId);
  meterEvent(env, { event: 'billing.api_operation', userId, wastelandId, label: 'publish' });
  return result;
}

export async function discardBranch(
  env: Env,
  wastelandId: string,
  userId: string,
  wantedId: string
): Promise<{ success: true }> {
  const ctx = await loadContext(env, wastelandId, userId);
  const result = await discardBranchViaSdk(ctx, wantedId);
  meterEvent(env, { event: 'billing.api_operation', userId, wastelandId, label: 'discard' });
  return result;
}

export async function listMyPulls(
  env: Env,
  wastelandId: string,
  userId: string
): Promise<MyPullEntry[]> {
  const ctx = await loadContext(env, wastelandId, userId);
  return listMyPullsViaSdk(ctx);
}
