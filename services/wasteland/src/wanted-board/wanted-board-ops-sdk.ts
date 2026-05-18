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
import { getWastelandDOStub } from '../dos/Wasteland.do';
import { deriveEncryptionKey, decryptToken } from '../util/crypto.util';
import { resolveSecret } from '../util/secret.util';
import { meterEvent } from '../util/billing.util';
import { fetchFreshDoltHubToken } from '../util/dolthub-token.util';
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

async function loadSdkContext(
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

export async function acceptWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  input: {
    itemId: string;
    quality: 'excellent' | 'good' | 'fair' | 'poor';
    reliability?: 'excellent' | 'good' | 'fair' | 'poor';
    severity?: 'leaf' | 'branch' | 'root';
    skillTags?: readonly string[];
    message?: string;
    direct?: boolean;
  }
): Promise<{ success: true }> {
  const ctx = await loadSdkContext(env, wastelandId, userId);
  const result = await acceptViaSdk(ctx, input);
  meterEvent(env, { event: 'billing.api_operation', userId, wastelandId, label: 'accept' });
  return result;
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
): Promise<{ success: true }> {
  const ctx = await loadSdkContext(env, wastelandId, userId);
  const result = await doneViaSdk(ctx, input);
  meterEvent(env, { event: 'billing.api_operation', userId, wastelandId, label: 'done' });
  return result;
}
