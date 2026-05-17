/**
 * Lifecycle ops — wasteland join (M2.7).
 *
 * Worker-bound layer over the inner functions in
 * `lifecycle-ops-inner.ts`. The wrapper:
 *
 *  1. Resolves DoltHub auth + fork coordinates via the local
 *     `loadContext` helper.
 *  2. Calls the matching `*ViaSdk` inner function.
 *  3. Persists the resolved `rig_handle` (and DoltHub username) onto
 *     the wasteland's stored credential so subsequent ops resolve the
 *     same handle the join PR was opened under.
 *  4. Emits a billing meter event.
 */

import { WantedBoardOpError } from '../wanted-board/errors';
import { getWastelandDOStub } from '../dos/Wasteland.do';
import { deriveEncryptionKey, encryptToken, decryptToken } from '../util/crypto.util';
import { resolveSecret } from '../util/secret.util';
import { fetchFreshDoltHubToken } from '../util/dolthub-token.util';
import { meterEvent } from '../util/billing.util';
import {
  joinViaSdk,
  type JoinOpResult,
  type LifecycleOpsInnerContext,
} from './lifecycle-ops-inner';

export type { JoinOpResult, LifecycleOpsInnerContext } from './lifecycle-ops-inner';

// ── Context resolution ───────────────────────────────────────────────────

type LifecycleContext = LifecycleOpsInnerContext & {
  doStub: ReturnType<typeof getWastelandDOStub>;
  /** Whether the auth token came from a fresh OAuth refresh — informs
   *  whether we re-encrypt-and-store the token after the join. */
  tokenSource: 'oauth' | 'stored';
};

export type JoinWastelandInput = {
  rigHandle: string;
  rigDisplayName?: string;
  rigEmail?: string;
};

/**
 * Resolve the credential needed to drive the join. Unlike the
 * branch-ops/wanted-board adapter:
 *   - we don't require `rigHandle` to be present yet — the caller's
 *     input is the source of truth (the connect wizard collects it
 *     from the user).
 *   - we do not require an existing credential row when a fresh OAuth
 *     token is available, because the wizard may call `joinWasteland`
 *     before any credential has been stored.
 */
async function loadContext(
  env: Env,
  wastelandId: string,
  userId: string,
  input: JoinWastelandInput
): Promise<LifecycleContext> {
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
      'DoltHub username unknown — connect DoltHub first to link your fork',
      'PRECONDITION_FAILED'
    );
  }

  const trimmedHandle = input.rigHandle.trim();
  if (trimmedHandle.length === 0) {
    throw new WantedBoardOpError('Rig handle is required', 'PRECONDITION_FAILED');
  }

  const displayName = input.rigDisplayName?.trim() || trimmedHandle;
  // Match the upstream-bootstrap default: a synthetic email so the
  // `hop_uri` column gets a stable value even when the wizard doesn't
  // collect one. The user can update it on the rigs row later.
  const ownerEmail = input.rigEmail?.trim() || `${trimmedHandle}@kilo.local`;

  if (fresh.status === 'ok') {
    return {
      doStub,
      upstream: config.dolthub_upstream,
      forkOrg: dolthubOrg,
      rigHandle: trimmedHandle,
      displayName,
      ownerEmail,
      token: fresh.data.token,
      tokenSource: 'oauth',
    };
  }

  if (fresh.status === 'unavailable') {
    console.warn('[lifecycle-ops:loadContext] fresh DoltHub token unavailable, falling back', {
      wastelandId,
      userId,
      reason: fresh.reason,
    });
  }

  if (!credential) {
    throw new WantedBoardOpError(
      'No DoltHub credential stored — connect DoltHub before joining the wasteland',
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
    rigHandle: trimmedHandle,
    displayName,
    ownerEmail,
    token,
    tokenSource: 'stored',
  };
}

// ── Worker-bound public ops ─────────────────────────────────────────────

/**
 * Run the wasteland join ceremony on behalf of the user.
 *
 * After the SDK finishes (fork + registration write + PR), persist
 * the verified `rig_handle` onto the wasteland's stored credential.
 * If the user reached this code path from the OAuth flow without a
 * prior `storeCredential`, encrypt and store the OAuth token now so
 * subsequent ops can fall back to it when the OAuth refresh path is
 * unavailable.
 */
export async function joinWasteland(
  env: Env,
  wastelandId: string,
  userId: string,
  input: JoinWastelandInput
): Promise<JoinOpResult> {
  const ctx = await loadContext(env, wastelandId, userId, input);
  const result = await joinViaSdk(ctx);

  // Persist credential update with the verified rig handle. We keep
  // the same encrypted_token if one was already stored; for the
  // OAuth-only path we encrypt and store the OAuth token so the
  // fallback path works after the OAuth session expires.
  await persistCredential(env, ctx, userId, result.rigHandle);

  meterEvent(env, {
    event: 'billing.api_operation',
    userId,
    wastelandId,
    label: 'join_wasteland',
  });

  return result;
}

async function persistCredential(
  env: Env,
  ctx: LifecycleContext,
  userId: string,
  rigHandle: string
): Promise<void> {
  const existing = await ctx.doStub.getCredential(userId);
  // We always need an encrypted_token to persist — re-use the existing
  // one when present, otherwise encrypt the OAuth token we just used.
  let encryptedToken: string;
  if (existing) {
    encryptedToken = existing.encrypted_token;
  } else {
    const rawKey = await resolveSecret(env.WASTELAND_ENCRYPTION_KEY);
    if (!rawKey) {
      // Without an encryption key we can't persist. Surface as a
      // soft warning rather than failing the whole join — the user
      // already has the PR, and the fallback path will prompt them
      // to reconnect later.
      console.warn(
        '[lifecycle-ops:persistCredential] encryption key unavailable; skipping credential save',
        { wastelandId: ctx.upstream, userId }
      );
      return;
    }
    const cryptoKey = await deriveEncryptionKey(rawKey);
    encryptedToken = await encryptToken(ctx.token, cryptoKey);
  }

  await ctx.doStub.storeCredential({
    userId,
    encryptedToken,
    dolthubOrg: ctx.forkOrg,
    rigHandle,
    isUpstreamAdmin: existing?.is_upstream_admin ?? false,
  });
}
