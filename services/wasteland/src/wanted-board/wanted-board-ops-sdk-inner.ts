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
    return new WantedBoardOpError(`${label} failed: ${err.message}`, code);
  }
  return new WantedBoardOpError(
    `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
    'UPSTREAM_ERROR'
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
 * Read the latest completion id for a wanted item off the caller's
 * `wl/<rigHandle>/<itemId>` fork branch. Used by `acceptViaSdk`
 * because the SDK requires an explicit `completionId`.
 */
async function readLatestCompletionId(
  ctx: SdkContext,
  wantedId: string,
  fetchImpl?: typeof fetch
): Promise<string | null> {
  const escapedId = wantedId.replace(/'/g, "''").replace(/\\/g, '\\\\');
  const sql = `SELECT id FROM completions WHERE wanted_id = '${escapedId}' ORDER BY submitted_at DESC LIMIT 1`;
  const slash = ctx.upstream.indexOf('/');
  if (slash <= 0) return null;
  const upstreamDb = ctx.upstream.slice(slash + 1);
  const branchName = `wl/${ctx.rigHandle}/${wantedId}`;
  try {
    const res = await doltRead({
      auth: { token: ctx.token },
      owner: ctx.forkOrg,
      db: upstreamDb,
      ref: branchName,
      query: sql,
      fetch: fetchImpl,
    });
    if (res.rows.length === 0) return null;
    const parsed = z.object({ id: z.string() }).passthrough().safeParse(res.rows[0]);
    return parsed.success ? parsed.data.id : null;
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
    const row = entry.fork?.row ?? entry.upstream;
    if (row === null) return { id: entry.wantedId };
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

export async function acceptViaSdk(
  ctx: SdkContext,
  input: {
    itemId: string;
    quality: 'excellent' | 'good' | 'fair' | 'poor';
    message?: string;
  },
  fetchImpl?: typeof fetch
): Promise<{ success: true }> {
  const completionId = await readLatestCompletionId(ctx, input.itemId, fetchImpl);
  if (!completionId) {
    throw new WantedBoardOpError(
      `Accept failed: no completion found on branch wl/${ctx.rigHandle}/${input.itemId}`,
      'PRECONDITION_FAILED'
    );
  }
  const wl = makeClient(ctx, fetchImpl);
  try {
    await wl.accept(input.itemId, {
      completionId,
      stamp: {
        id: makeStampId(input.itemId),
        subject: ctx.rigHandle,
        quality: QUALITY_TO_INT[input.quality],
        reliability: QUALITY_TO_INT[input.quality],
        severity: 'info',
        message: input.message,
      },
    });
  } catch (err) {
    throw wrapSdkError(err, 'Accept');
  }
  return { success: true };
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
  },
  fetchImpl?: typeof fetch
): Promise<{ success: true; wantedId: string }> {
  const wl = makeClient(ctx, fetchImpl);
  const wantedId = makeWantedId();
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
  } catch (err) {
    throw wrapSdkError(err, 'Post');
  }
  return { success: true, wantedId };
}

export async function doneViaSdk(
  ctx: SdkContext,
  input: { itemId: string; evidence: string },
  fetchImpl?: typeof fetch
): Promise<{ success: true }> {
  const wl = makeClient(ctx, fetchImpl);
  try {
    await wl.done(input.itemId, { evidence: input.evidence });
  } catch (err) {
    throw wrapSdkError(err, 'Mark done');
  }
  return { success: true };
}
