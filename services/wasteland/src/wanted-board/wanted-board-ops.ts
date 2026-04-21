/**
 * Wanted board operations — shared business logic used by both the tRPC
 * router and the WastelandRPCEntrypoint. Each function owns the full
 * operation: credential decryption, container dispatch, result parsing,
 * cache refresh, and metering.
 *
 * All ownership/auth checks happen in the callers (tRPC via
 * resolveWastelandOwnership, RPC via the fact that only peer workers
 * can call the binding).
 */

import { z } from 'zod';
import { getWastelandDOStub } from '../dos/Wasteland.do';
import { getWastelandContainerStub } from '../dos/WastelandContainer.do';
import { deriveEncryptionKey, decryptToken } from '../util/crypto.util';
import { resolveSecret } from '../util/secret.util';
import { meterEvent } from '../util/billing.util';

// ── Error ───────────────────────────────────────────────────────────────

export class WantedBoardOpError extends Error {
  constructor(
    message: string,
    /** Maps roughly to HTTP/tRPC codes. Callers translate as needed. */
    readonly code: 'NOT_FOUND' | 'PRECONDITION_FAILED' | 'INTERNAL_SERVER_ERROR' | 'UPSTREAM_ERROR'
  ) {
    super(message);
    this.name = 'WantedBoardOpError';
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

type LoadContextResult = {
  doStub: ReturnType<typeof getWastelandDOStub>;
  upstream: string;
  token: string;
  isUpstreamAdmin: boolean;
};

/**
 * Load the wasteland config + credential for the user, decrypt the token,
 * and return everything needed to dispatch a container request.
 */
async function loadContext(
  env: Env,
  wastelandId: string,
  userId: string
): Promise<LoadContextResult> {
  const doStub = getWastelandDOStub(env, wastelandId);

  const config = await doStub.getConfig();
  if (!config?.dolthub_upstream) {
    throw new WantedBoardOpError(
      'Wasteland has no DoltHub upstream configured',
      'PRECONDITION_FAILED'
    );
  }

  const credential = await doStub.getCredential(userId);
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
    token,
    isUpstreamAdmin: credential.is_upstream_admin,
  };
}

/**
 * Resolve whether to pass `--direct` to the wl CLI. The caller can request
 * direct mode, but it's only honored when the user has admin rights on the
 * upstream (stored as `is_upstream_admin` on the credential). If a caller
 * without admin asks for direct mode, we silently downgrade to PR mode —
 * the admin flag is a safety check, not an authorization failure mode.
 */
function resolveDirect(requested: boolean | undefined, isUpstreamAdmin: boolean): boolean {
  return requested === true && isUpstreamAdmin;
}

type ContainerPath =
  | '/wl/browse'
  | '/wl/claim'
  | '/wl/unclaim'
  | '/wl/post'
  | '/wl/done'
  | '/wl/accept'
  | '/wl/reject'
  | '/wl/close';

/** Dispatch a request to the wasteland container and throw on non-ok responses. */
async function callContainer(
  env: Env,
  wastelandId: string,
  path: ContainerPath,
  token: string,
  body: Record<string, unknown>,
  errorLabel: string
): Promise<unknown> {
  const container = getWastelandContainerStub(env, wastelandId);
  const res = await container.fetch(
    new Request(`http://container${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', DOLTHUB_TOKEN: token },
      body: JSON.stringify(body),
    })
  );

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new WantedBoardOpError(
      `${errorLabel} failed: ${text || res.statusText}`,
      'UPSTREAM_ERROR'
    );
  }

  return res.json();
}

// ── Schemas ─────────────────────────────────────────────────────────────

const PriorityEnum = z.enum(['low', 'medium', 'high', 'critical']);
const TypeEnum = z.enum(['feature', 'bug', 'docs', 'other']);

const PRIORITY_TO_NUMBER: Record<z.infer<typeof PriorityEnum>, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// ── Operations ──────────────────────────────────────────────────────────

export async function browseWantedBoard(
  env: Env,
  wastelandId: string,
  userId: string
): Promise<Array<Record<string, unknown>>> {
  const { token, upstream } = await loadContext(env, wastelandId, userId);

  const data = await callContainer(env, wastelandId, '/wl/browse', token, { upstream }, 'Browse');

  const parsed = z.object({ items: z.array(z.record(z.string(), z.unknown())) }).safeParse(data);
  return parsed.success ? parsed.data.items : [];
}

export async function claimWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  itemId: string,
  options?: { direct?: boolean }
): Promise<{ success: true }> {
  const { doStub, token, upstream, isUpstreamAdmin } = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(options?.direct, isUpstreamAdmin);

  await callContainer(
    env,
    wastelandId,
    '/wl/claim',
    token,
    { upstream, itemId, userId, direct },
    'Claim'
  );

  await doStub.refreshWantedBoard();

  meterEvent(env, {
    event: 'billing.api_operation',
    userId,
    wastelandId,
    label: 'claim',
  });

  return { success: true };
}

export async function unclaimWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  itemId: string,
  options?: { direct?: boolean }
): Promise<{ success: true }> {
  const { doStub, token, upstream, isUpstreamAdmin } = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(options?.direct, isUpstreamAdmin);

  await callContainer(
    env,
    wastelandId,
    '/wl/unclaim',
    token,
    { upstream, itemId, direct },
    'Unclaim'
  );

  await doStub.refreshWantedBoard();

  meterEvent(env, {
    event: 'billing.api_operation',
    userId,
    wastelandId,
    label: 'unclaim',
  });

  return { success: true };
}

export async function acceptWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  input: {
    itemId: string;
    quality: 'excellent' | 'good' | 'fair' | 'poor';
    comment?: string;
    direct?: boolean;
  }
): Promise<{ success: true }> {
  const { doStub, token, upstream, isUpstreamAdmin } = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(input.direct, isUpstreamAdmin);

  await callContainer(
    env,
    wastelandId,
    '/wl/accept',
    token,
    {
      upstream,
      itemId: input.itemId,
      quality: input.quality,
      ...(input.comment ? { comment: input.comment } : {}),
      direct,
    },
    'Accept'
  );

  await doStub.refreshWantedBoard();

  meterEvent(env, {
    event: 'billing.api_operation',
    userId,
    wastelandId,
    label: 'accept',
  });

  return { success: true };
}

export async function rejectWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  input: { itemId: string; comment: string; direct?: boolean }
): Promise<{ success: true }> {
  const { doStub, token, upstream, isUpstreamAdmin } = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(input.direct, isUpstreamAdmin);

  await callContainer(
    env,
    wastelandId,
    '/wl/reject',
    token,
    { upstream, itemId: input.itemId, comment: input.comment, direct },
    'Reject'
  );

  await doStub.refreshWantedBoard();

  meterEvent(env, {
    event: 'billing.api_operation',
    userId,
    wastelandId,
    label: 'reject',
  });

  return { success: true };
}

export async function closeWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  itemId: string,
  options?: { direct?: boolean }
): Promise<{ success: true }> {
  const { doStub, token, upstream, isUpstreamAdmin } = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(options?.direct, isUpstreamAdmin);

  await callContainer(env, wastelandId, '/wl/close', token, { upstream, itemId, direct }, 'Close');

  await doStub.refreshWantedBoard();

  meterEvent(env, {
    event: 'billing.api_operation',
    userId,
    wastelandId,
    label: 'close',
  });

  return { success: true };
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
  }
): Promise<{ success: true }> {
  const { doStub, token, upstream, isUpstreamAdmin } = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(input.direct, isUpstreamAdmin);

  await callContainer(
    env,
    wastelandId,
    '/wl/post',
    token,
    {
      upstream,
      title: input.title,
      description: input.description,
      ...(input.priority !== undefined ? { priority: PRIORITY_TO_NUMBER[input.priority] } : {}),
      ...(input.type !== undefined ? { type: input.type } : {}),
      direct,
    },
    'Post'
  );

  await doStub.refreshWantedBoard();

  meterEvent(env, {
    event: 'billing.api_operation',
    userId,
    wastelandId,
    label: 'post',
  });

  return { success: true };
}

export async function markWantedItemDone(
  env: Env,
  wastelandId: string,
  userId: string,
  input: { itemId: string; evidence: string; direct?: boolean }
): Promise<{ success: true }> {
  const { doStub, token, upstream, isUpstreamAdmin } = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(input.direct, isUpstreamAdmin);

  await callContainer(
    env,
    wastelandId,
    '/wl/done',
    token,
    { upstream, itemId: input.itemId, evidence: input.evidence, direct },
    'Mark done'
  );

  await doStub.refreshWantedBoard();

  meterEvent(env, {
    event: 'billing.api_operation',
    userId,
    wastelandId,
    label: 'done',
  });

  return { success: true };
}
