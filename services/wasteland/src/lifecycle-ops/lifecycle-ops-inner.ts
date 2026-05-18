/**
 * Inner lifecycle-ops functions, decoupled from the worker `Env` and
 * the WastelandDO. Each function takes a pre-resolved
 * {@link LifecycleOpsInnerContext} and an optional injected `fetch`,
 * then drives {@link WlClient} to produce the tRPC return shape.
 *
 * This split mirrors `branch-ops-inner.ts`. It exists so the unit
 * tests in `lifecycle-ops.test.ts` can exercise the SDK→tRPC mapping
 * at the fetch boundary without touching `getWastelandDOStub` (which
 * transitively imports `cloudflare:workers` and breaks the Node-only
 * vitest pool).
 *
 * The wrapper in `lifecycle-ops.ts` adds credential resolution,
 * credential persistence, and metering on top of these.
 */

import { WlClient, WlError, WL_SDK_VERSION, type JoinResult } from '@kilocode/wl-sdk';
import { WantedBoardOpError } from '../wanted-board/errors';

// ── Types ────────────────────────────────────────────────────────────────

export type LifecycleOpsInnerContext = {
  /** Upstream `owner/db`, e.g. `"hop/wl-commons"`. */
  upstream: string;
  /** Caller's DoltHub username/org that owns (or will own) the fork. */
  forkOrg: string;
  /** Rig handle to register on upstream. */
  rigHandle: string;
  /** Display name written to the registration row. */
  displayName: string;
  /** Owner email written to the registration row. */
  ownerEmail: string;
  /** DoltHub OAuth or PAT token. */
  token: string;
};

export type JoinOpResult = {
  forkOwner: string;
  forkRepo: string;
  forkUrl: string;
  rigHandle: string;
  registrationBranch: string;
  /** Pull id on upstream; null if PR creation was best-effort skipped. */
  registrationPullId: string | null;
  /** Pull URL on upstream; null if PR creation was best-effort skipped. */
  registrationPullUrl: string | null;
  /** True when the fork already existed (so we just confirmed registration). */
  alreadyJoined: boolean;
};

// ── Helpers ──────────────────────────────────────────────────────────────

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
    return new WantedBoardOpError(`${label} failed: ${err.message}`, code, err.cause ?? err);
  }
  return new WantedBoardOpError(
    `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
    'UPSTREAM_ERROR',
    err
  );
}

function parseUpstream(spec: string): { owner: string; db: string } {
  const slash = spec.indexOf('/');
  if (slash <= 0 || slash === spec.length - 1) {
    throw new WantedBoardOpError(
      `Wasteland upstream "${spec}" is malformed — expected "owner/db"`,
      'PRECONDITION_FAILED'
    );
  }
  return { owner: spec.slice(0, slash), db: spec.slice(slash + 1) };
}

// ── Public ops ───────────────────────────────────────────────────────────

/**
 * Run the full join ceremony against the upstream — fork, write
 * registration row to `wl/register/<handle>`, open the registration PR.
 *
 * The SDK's `join` is idempotent end-to-end: re-forking returns the
 * existing fork, the registration write uses `ON DUPLICATE KEY UPDATE`,
 * and an existing open registration PR matching the title is returned
 * rather than re-opened. So a retry from the wizard is safe.
 */
export async function joinViaSdk(
  ctx: LifecycleOpsInnerContext,
  fetchImpl?: typeof fetch
): Promise<JoinOpResult> {
  const upstream = parseUpstream(ctx.upstream);
  const wl = new WlClient({
    upstream: ctx.upstream,
    forkOrg: ctx.forkOrg,
    rigHandle: ctx.rigHandle,
    token: ctx.token,
    fetch: fetchImpl,
  });

  let result: JoinResult;
  try {
    result = await wl.join({
      displayName: ctx.displayName,
      ownerEmail: ctx.ownerEmail,
      version: `cloud-worker:${WL_SDK_VERSION}`,
    });
  } catch (err) {
    throw wrapSdkError(err, 'Join wasteland');
  }

  return {
    forkOwner: ctx.forkOrg,
    forkRepo: upstream.db,
    forkUrl: result.forkUrl,
    rigHandle: ctx.rigHandle,
    registrationBranch: result.branchName,
    registrationPullId: result.registrationPullId.length > 0 ? result.registrationPullId : null,
    registrationPullUrl: result.registrationPrUrl.length > 0 ? result.registrationPrUrl : null,
    // `forkCreated === false` means the fork existed — we treat that
    // as "already joined" for UI purposes. The registration write and
    // PR check are still idempotent on this path, so the returned PR
    // url either points at the previously-opened registration PR or
    // to a freshly opened one if the prior attempt didn't reach Step 3.
    alreadyJoined: !result.forkCreated,
  };
}
