/**
 * Wanted board operations — shared business logic used by both the tRPC
 * router and the WastelandRPCEntrypoint. Each function owns the full
 * operation: credential resolution, libwl dispatch, result parsing,
 * cache refresh, and metering.
 *
 * Implementation: every op runs through the libwl WASM bundle. The
 * Cloudflare Container is no longer dispatched to from this file —
 * see `docs/wasm-poc.md` for the migration story.
 *
 * All ownership/auth checks happen in the callers (tRPC via
 * resolveWastelandOwnership, RPC via the fact that only peer workers
 * can call the binding).
 */

import { z } from 'zod';
import { getWastelandDOStub } from '../dos/Wasteland.do';
import { deriveEncryptionKey, decryptToken } from '../util/crypto.util';
import { resolveSecret } from '../util/secret.util';
import { meterEvent } from '../util/billing.util';
import { fetchFreshDoltHubToken } from '../util/dolthub-token.util';
import { callLibwl, type LibwlOp } from '../wasm/libwl-runner';

// ── Error ───────────────────────────────────────────────────────────────

// `WantedBoardOpError` lives in `./errors.ts` so the SDK adapter
// (`./wanted-board-ops-sdk-inner.ts`) can import it without dragging
// in this module's libwl runtime imports.
import { WantedBoardOpError } from './errors';
export { WantedBoardOpError };

// ── Helpers ─────────────────────────────────────────────────────────────

type LoadContextResult = {
  doStub: ReturnType<typeof getWastelandDOStub>;
  upstream: string;
  token: string;
  rigHandle: string;
  /**
   * The user's DoltHub username — the org under which their fork of
   * the upstream commons lives. libwl uses this as `fork_org` when
   * computing the write target for the DoltHub REST API.
   *
   * Resolved from (in order): the fresh-token endpoint's
   * `dolthubUsername`, the local credential row's `dolthub_org`. Both
   * are populated during the connect flow; we throw
   * `PRECONDITION_FAILED` if neither yields a value because the wasm
   * has no sensible fallback (using the Kilo userId UUID as a fork org
   * fails on DoltHub branch-name validation).
   */
  dolthubOrg: string;
  isUpstreamAdmin: boolean;
};

/**
 * Load the wasteland config + a usable DoltHub access token + rig
 * identity for the user. Returns everything needed to dispatch a
 * libwl call.
 *
 * Token resolution order:
 *
 * 1. **Fresh OAuth token from the web app** — call
 *    `/api/internal/integrations/dolthub/token`, which runs the OAuth
 *    refresh flow if the access token is expired. This is the
 *    preferred path because the web app owns the OAuth lifecycle and
 *    holds the canonical refresh token.
 * 2. **Locally stored credential** — fallback for users who connected
 *    via the manual API token path (production), and for transient web
 *    app failures. The local copy is encrypted with
 *    `WASTELAND_ENCRYPTION_KEY` and decrypted on demand.
 *
 * If neither is available we throw `PRECONDITION_FAILED` so the caller
 * can prompt the user to connect.
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

  // Attempt 1: ask the web app for a fresh OAuth access token.
  // The org-level integration isn't wired through the wasteland UI yet,
  // so we look up the user-level integration by default.
  const fresh = await fetchFreshDoltHubToken(env, { userId });

  // We need the local credential row regardless because it carries the
  // rig handle, the DoltHub username (when the local manual-token flow
  // was used), and the `is_upstream_admin` flag for the direct-mode
  // gate. May be `null` when the user only authenticated via OAuth —
  // see fallbacks below.
  const credential = await doStub.getCredential(userId);
  const isUpstreamAdmin = credential?.is_upstream_admin ?? false;

  // Resolve the DoltHub username (used as the fork-org for libwl
  // writes). Prefer the OAuth response, fall back to the local
  // credential. We do not fall back to the Kilo userId — UUIDs aren't
  // valid DoltHub orgs and would fail downstream branch creation.
  const dolthubOrg =
    (fresh.status === 'ok' ? fresh.data.dolthubUsername : null) ?? credential?.dolthub_org ?? null;
  if (!dolthubOrg) {
    throw new WantedBoardOpError(
      'DoltHub username unknown — reconnect DoltHub in settings to refresh',
      'PRECONDITION_FAILED'
    );
  }

  // Rig handle is what shows up as `posted_by` / `claimed_by` and is
  // embedded in branch names (`wl/<rigHandle>/<wantedId>`). DoltHub
  // restricts branch names to 3-32 chars of letters/dashes/underscores,
  // so falling back to the Kilo userId UUID is not viable. The
  // DoltHub username is a sane fallback (3-39 chars by their rules),
  // truncated to 32 to be safe.
  const rigHandle = credential?.rig_handle ?? dolthubOrg.slice(0, 32);

  if (fresh.status === 'ok') {
    return {
      doStub,
      upstream: config.dolthub_upstream,
      token: fresh.data.token,
      rigHandle,
      dolthubOrg,
      isUpstreamAdmin,
    };
  }

  if (fresh.status === 'unavailable') {
    // Don't fail — the local credential might still be valid. Log so
    // we notice if the fresh-token path is broken everywhere.
    console.warn('[loadContext] fresh DoltHub token unavailable, falling back', {
      wastelandId,
      userId,
      reason: fresh.reason,
    });
  }

  // Attempt 2: locally stored credential (manual API token, or stale
  // OAuth token when the web app is unavailable).
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
    rigHandle,
    dolthubOrg,
    isUpstreamAdmin,
  };
}

/**
 * Resolve whether to enable direct (wild-west) mode on libwl. The caller
 * can request direct, but it's only honored when the user has admin
 * rights on the upstream (`is_upstream_admin` on the credential). If a
 * caller without admin asks for direct mode, we silently downgrade to
 * PR mode — the admin flag is a safety check, not an authorization
 * failure mode. If we have no local credential at all (OAuth-only),
 * direct is never available.
 */
function resolveDirect(requested: boolean | undefined, isUpstreamAdmin: boolean): boolean {
  return requested === true && isUpstreamAdmin;
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

/**
 * `wl accept --quality` is an integer 1-5. The wasteland service
 * exposes a 4-level enum to keep the public API friendly. Lifted
 * verbatim from `container/control-server/server.ts:QUALITY_TO_INT`
 * (preserved during the wasm migration so any UI calling
 * `acceptWantedItem` keeps working).
 */
const QUALITY_TO_INT: Record<'excellent' | 'good' | 'fair' | 'poor', number> = {
  excellent: 5,
  good: 4,
  fair: 3,
  poor: 2,
};

/**
 * Loose schema for libwl's `BrowseResult`. The Go side serializes the
 * `sdk.BrowseResult` struct without explicit JSON tags, so field names
 * follow Go's default capitalized form: `Items`, `PendingIDs`,
 * `UpstreamPending`. We accept either casing here so the schema keeps
 * working if the Go side is later updated to add `json:"items"` tags.
 */
const LibwlBrowseResultSchema = z
  .object({
    Items: z.array(z.record(z.string(), z.unknown())).optional(),
    items: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

/**
 * Loose schema for libwl's `MutationResult`. Same Go-default casing
 * caveat as `LibwlBrowseResultSchema`. We only extract the PR URL
 * (used by `claim`); the rest of the envelope is opaque to callers
 * for now.
 */
const LibwlMutationResultSchema = z
  .object({
    Detail: z
      .object({
        PRURL: z.string().optional(),
        PrURL: z.string().optional(),
        pr_url: z.string().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    detail: z
      .object({
        PRURL: z.string().optional(),
        PrURL: z.string().optional(),
        pr_url: z.string().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

/**
 * Pull a PR URL out of a libwl MutationResult envelope. Returns null
 * if no PR was created (wild-west mode, idempotent no-op, etc.) — note
 * that libwl serializes a missing PR as the empty string rather than
 * `null` because the Go field is `string`, not `*string`. We treat
 * empty as missing here.
 */
function extractPrUrl(result: unknown): string | null {
  const parsed = LibwlMutationResultSchema.safeParse(result);
  if (!parsed.success) return null;
  const detail = parsed.data.Detail ?? parsed.data.detail;
  if (!detail) return null;
  const url = detail.PRURL ?? detail.PrURL ?? detail.pr_url ?? '';
  return url === '' ? null : url;
}

/**
 * Common shape of every libwl mutation input: an `Env` block plus
 * op-specific fields. Centralizing this here makes the per-op
 * functions short and keeps the env spelling consistent with
 * `wasteland/wlwasm/api.go:Env`.
 *
 * `fork_org` is the user's DoltHub username — libwl uses it as the
 * write target on DoltHub's REST API (`{forkOrg}/{forkDb}/write/...`).
 * `fork_db` is omitted; libwl defaults to the upstream DB name, which
 * is correct because DoltHub forks share the upstream DB name.
 */
type LibwlEnv = {
  upstream: string;
  dolthub_token: string;
  user_id: string;
  rig_handle: string;
  fork_org: string;
  direct: boolean;
};

function libwlEnv(ctx: LoadContextResult, userId: string, direct: boolean): LibwlEnv {
  return {
    upstream: ctx.upstream,
    dolthub_token: ctx.token,
    user_id: userId,
    rig_handle: ctx.rigHandle,
    fork_org: ctx.dolthubOrg,
    direct,
  };
}

/**
 * Run a libwl mutation, translating runtime errors to
 * `WantedBoardOpError`. Each op is responsible for its own input shape
 * and post-processing (refresh + metering); this helper just owns the
 * call boundary.
 */
async function runLibwlMutation(
  op: Exclude<LibwlOp, 'wlBrowse'>,
  input: Record<string, unknown>,
  errorLabel: string
): Promise<unknown> {
  try {
    return await callLibwl<unknown>(op, input);
  } catch (err) {
    throw new WantedBoardOpError(
      `${errorLabel} failed: ${err instanceof Error ? err.message : String(err)}`,
      'UPSTREAM_ERROR'
    );
  }
}

// ── Operations ──────────────────────────────────────────────────────────

/**
 * Browse via the libwl WASM bundle (`services/wasteland/src/wasm/libwl.wasm`).
 *
 * Replaces the previous container-backed implementation. The wasm path
 * runs the wasteland Go SDK in-process inside the Worker, calling the
 * DoltHub REST API directly via Go's `net/http` (which on `js/wasm`
 * uses `globalThis.fetch`). No container is involved.
 *
 * Background and validation: see `docs/wasm-poc.md`.
 */
export async function browseWantedBoard(
  env: Env,
  wastelandId: string,
  userId: string
): Promise<Array<Record<string, unknown>>> {
  const ctx = await loadContext(env, wastelandId, userId);

  let result: unknown;
  try {
    result = await callLibwl<unknown>('wlBrowse', {
      ...libwlEnv(ctx, userId, false),
      // View: 'all' reproduces the previous container behavior, which
      // returned every row in the `wanted` table without filtering. The
      // SDK's default in PR mode is 'mine' (only items claimed/posted
      // by the calling rig); leaving that on would silently empty the
      // wanted board for users who haven't yet claimed anything.
      view: 'all',
      // Priority -1 disables the priority filter on the SDK side.
      // The Go `BrowseFilter.Priority` field uses -1 as the "unset"
      // sentinel; omitting it from the JSON unmarshals to 0, which
      // would silently restrict the result set to priority=0 items.
      priority: -1,
    });
  } catch (err) {
    throw new WantedBoardOpError(
      `Browse failed: ${err instanceof Error ? err.message : String(err)}`,
      'UPSTREAM_ERROR'
    );
  }

  const parsed = LibwlBrowseResultSchema.safeParse(result);
  if (!parsed.success) return [];
  return parsed.data.Items ?? parsed.data.items ?? [];
}

export async function claimWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  itemId: string,
  options?: { direct?: boolean }
): Promise<{ success: true; pr_url: string | null }> {
  const ctx = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(options?.direct, ctx.isUpstreamAdmin);

  const raw = await runLibwlMutation(
    'wlClaim',
    { ...libwlEnv(ctx, userId, direct), item_id: itemId },
    'Claim'
  );
  const prUrl = extractPrUrl(raw);

  await ctx.doStub.refreshWantedBoard();

  meterEvent(env, {
    event: 'billing.api_operation',
    userId,
    wastelandId,
    label: 'claim',
  });

  return { success: true, pr_url: prUrl };
}

export async function unclaimWantedItem(
  env: Env,
  wastelandId: string,
  userId: string,
  itemId: string,
  options?: { direct?: boolean }
): Promise<{ success: true }> {
  const ctx = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(options?.direct, ctx.isUpstreamAdmin);

  await runLibwlMutation(
    'wlUnclaim',
    { ...libwlEnv(ctx, userId, direct), item_id: itemId },
    'Unclaim'
  );

  await ctx.doStub.refreshWantedBoard();

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
    /** Free-form message attached to the stamp (written to `stamps.message`). */
    message?: string;
    direct?: boolean;
  }
): Promise<{ success: true }> {
  const ctx = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(input.direct, ctx.isUpstreamAdmin);

  await runLibwlMutation(
    'wlAccept',
    {
      ...libwlEnv(ctx, userId, direct),
      item_id: input.itemId,
      quality: QUALITY_TO_INT[input.quality],
      ...(input.message ? { message: input.message } : {}),
    },
    'Accept'
  );

  await ctx.doStub.refreshWantedBoard();

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
  input: {
    itemId: string;
    /**
     * Rejection reason — becomes part of the `wl reject` commit message.
     * Maps to `--reason` on the wl CLI (not `--comment`, which is an
     * approve/request-changes flag).
     */
    reason: string;
    direct?: boolean;
  }
): Promise<{ success: true }> {
  const ctx = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(input.direct, ctx.isUpstreamAdmin);

  await runLibwlMutation(
    'wlReject',
    {
      ...libwlEnv(ctx, userId, direct),
      item_id: input.itemId,
      reason: input.reason,
    },
    'Reject'
  );

  await ctx.doStub.refreshWantedBoard();

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
  const ctx = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(options?.direct, ctx.isUpstreamAdmin);

  await runLibwlMutation('wlClose', { ...libwlEnv(ctx, userId, direct), item_id: itemId }, 'Close');

  await ctx.doStub.refreshWantedBoard();

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
  const ctx = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(input.direct, ctx.isUpstreamAdmin);

  await runLibwlMutation(
    'wlPost',
    {
      ...libwlEnv(ctx, userId, direct),
      title: input.title,
      description: input.description,
      // Default priority='medium' (1) when the caller didn't specify, to
      // match the previous container behavior. The Go side has no
      // explicit "unset" sentinel for `PostInput.Priority`, so missing
      // would unmarshal to 0 (= 'low'), shifting every untyped post.
      priority:
        input.priority !== undefined
          ? PRIORITY_TO_NUMBER[input.priority]
          : PRIORITY_TO_NUMBER.medium,
      ...(input.type !== undefined ? { type: input.type } : {}),
    },
    'Post'
  );

  await ctx.doStub.refreshWantedBoard();

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
  const ctx = await loadContext(env, wastelandId, userId);
  const direct = resolveDirect(input.direct, ctx.isUpstreamAdmin);

  await runLibwlMutation(
    'wlDone',
    {
      ...libwlEnv(ctx, userId, direct),
      item_id: input.itemId,
      evidence: input.evidence,
    },
    'Mark done'
  );

  await ctx.doStub.refreshWantedBoard();

  meterEvent(env, {
    event: 'billing.api_operation',
    userId,
    wastelandId,
    label: 'done',
  });

  return { success: true };
}
