/**
 * Thin client for the DoltHub REST API — used by admin-mode tRPC procedures
 * to list, merge, and close pull requests on an upstream repo.
 *
 * Callers pass a token explicitly; this module never reads from secrets.
 * All responses are validated with Zod before being returned.
 */

import { z } from 'zod';

export const DOLTHUB_API_BASE = 'https://www.dolthub.com/api/v1alpha1';

export class DoltHubApiError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'DoltHubApiError';
  }
}

/**
 * Parse a DoltHub upstream string (e.g. "hop/wl-commons") into owner + db.
 */
export function parseUpstream(upstream: string): { owner: string; db: string } {
  const [owner, db] = upstream.split('/');
  if (!owner || !db) {
    throw new DoltHubApiError(`Invalid upstream "${upstream}" (expected "owner/db")`, 400);
  }
  return { owner, db };
}

/**
 * Build the DoltHub web URL for a pull request on `upstream`. Used to
 * surface a "view this PR" link in the wanted-board UI.
 */
export function buildPullWebUrl(upstream: string, pullId: string): string {
  const { owner, db } = parseUpstream(upstream);
  return `https://www.dolthub.com/repositories/${owner}/${db}/pulls/${pullId}`;
}

/**
 * Probes a DoltHub upstream (`{owner}/{db}`) to confirm the repo exists.
 * Two-stage probe so we don't trip DoltHub's "Calls authenticated with a
 * token must include a refName" 400 on token-authed branchless calls:
 *
 *   1. Anonymous `SELECT 1` against `/{owner}/{db}` — works for any
 *      public repo, no refName required.
 *   2. Only when stage 1 says "no such repository" AND a token is
 *      provided: authenticated `SELECT 1` against `/{owner}/{db}/main`.
 *      A `200 Error "branch not found"` here also proves the repo
 *      exists (just with a non-`main` default branch).
 *
 * Returns `false` for both genuine misses and any unexpected response.
 * Callers should treat `false` as "do not push WL_UPSTREAM yet" rather
 * than as a hard failure — repos can come into existence asynchronously
 * (e.g. immediately after `wl create`).
 */
const UpstreamProbeResponse = z
  .object({
    query_execution_status: z.string().optional(),
    query_execution_message: z.string().optional(),
  })
  .passthrough();

export async function upstreamExistsOnDolthub(
  upstream: string,
  token: string | null
): Promise<boolean> {
  const { owner, db } = parseUpstream(upstream);

  // Stage 1: anonymous probe. Transport failures resolve to false rather
  // than throw — callers (e.g. storeCredential) treat a false return as
  // "skip the optional follow-up push" and shouldn't have an init path
  // crash on a transient network blip.
  const anonUrl = `${DOLTHUB_API_BASE}/${encodeURIComponent(owner)}/${encodeURIComponent(db)}?q=${encodeURIComponent('SELECT 1')}`;
  let anonRes: Response | null = null;
  try {
    anonRes = await fetch(anonUrl, { headers: { 'cache-control': 'no-cache' } });
  } catch {
    anonRes = null;
  }
  if (anonRes && anonRes.ok) {
    const anonParsed = UpstreamProbeResponse.safeParse(await anonRes.json().catch(() => null));
    if (anonParsed.success && anonParsed.data.query_execution_status === 'Success') {
      return true;
    }
  }
  if (!token) return false;

  // Stage 2: authenticated /main probe (only fires when we have a token
  // and stage 1 didn't already resolve).
  const authUrl = `${DOLTHUB_API_BASE}/${encodeURIComponent(owner)}/${encodeURIComponent(db)}/main?q=${encodeURIComponent('SELECT 1')}`;
  let authRes: Response | null = null;
  try {
    authRes = await fetch(authUrl, {
      headers: { authorization: `token ${token}`, 'cache-control': 'no-cache' },
    });
  } catch {
    return false;
  }
  if (!authRes.ok) return false;
  const authParsed = UpstreamProbeResponse.safeParse(await authRes.json().catch(() => null));
  if (!authParsed.success) return false;
  const data = authParsed.data;
  if (data.query_execution_status === 'Success') return true;
  // 200 with status=Error and "branch not found" — repo exists, just on
  // a different default branch.
  if (
    data.query_execution_status === 'Error' &&
    /branch not found/i.test(data.query_execution_message ?? '')
  ) {
    return true;
  }
  return false;
}

type DoltFetchInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

async function doltFetch(
  path: string,
  token: string,
  init?: DoltFetchInit
): Promise<{ status: number; data: unknown }> {
  // Bypass any edge cache between us and DoltHub. Merged PRs and
  // freshly-opened pulls need to be visible to the worker immediately;
  // stale reads surface as stuck "pending review" badges or a wanted
  // board that doesn't reflect the post-merge state. Workerd rejects
  // the standard DOM `cache: 'no-store'` init option — the cache-control
  // header is what actually propagates through its subrequest cache.
  const res = await fetch(`${DOLTHUB_API_BASE}${path}`, {
    ...init,
    headers: {
      'cache-control': 'no-cache',
      ...(init?.headers ?? {}),
      authorization: `token ${token}`,
    },
  });
  const data: unknown = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// ── List PRs ──────────────────────────────────────────────────────────

export const DoltHubPull = z
  .object({
    pull_id: z.union([z.string(), z.number()]).transform(v => String(v)),
    title: z.string().default(''),
    description: z.string().nullable().default(null),
    state: z.string(),
    created_at: z.string().nullable().default(null),
    updated_at: z.string().nullable().default(null),
    creator_name: z.string().nullable().default(null),
  })
  .passthrough();

const PullsResponse = z.object({ pulls: z.array(DoltHubPull) }).passthrough();

export type DoltHubPullT = z.infer<typeof DoltHubPull>;

/**
 * List pull requests on the upstream repo, optionally filtered by state
 * ("Open" | "Closed" | "Merged"). The DoltHub API ignores the `state` query
 * parameter server-side, so we always fetch all and filter client-side.
 */
export async function listPulls(
  upstream: string,
  token: string,
  opts: { state?: 'Open' | 'Closed' | 'Merged' } = {}
): Promise<DoltHubPullT[]> {
  const { owner, db } = parseUpstream(upstream);
  const { status, data } = await doltFetch(`/${owner}/${db}/pulls`, token);
  if (status >= 400) {
    throw new DoltHubApiError(`List pulls failed (${status})`, status);
  }
  const parsed = PullsResponse.safeParse(data);
  if (!parsed.success) return [];
  if (!opts.state) return parsed.data.pulls;
  const want = opts.state.toLowerCase();
  return parsed.data.pulls.filter(p => p.state.toLowerCase() === want);
}

// ── PR detail ──────────────────────────────────────────────────────────

// DoltHub's REST API returns PR detail with inconsistent field names —
// the older `from_branch` / `from_branch_owner` / `from_branch_database`
// shape is what the canonical wasteland CLI reads, but some endpoints
// also expose the suffixed `_name` variants. Accept both and normalize
// via `getPull` below so callers only see one shape.
const DoltHubPullDetailRaw = z
  .object({
    pull_id: z.union([z.string(), z.number()]).transform(v => String(v)),
    title: z.string().default(''),
    description: z.string().nullable().default(null),
    state: z.string(),
    // Branch name — prefer the un-suffixed form.
    from_branch: z.string().nullable().optional(),
    from_branch_name: z.string().nullable().optional(),
    to_branch: z.string().nullable().optional(),
    to_branch_name: z.string().nullable().optional(),
    // Fork owner / database — needed to route branch-tip SQL to the
    // correct repo (the fork, not the upstream where the PR lives).
    from_branch_owner: z.string().nullable().optional(),
    from_branch_owner_name: z.string().nullable().optional(),
    from_branch_database: z.string().nullable().optional(),
    from_branch_repo_name: z.string().nullable().optional(),
    author: z.string().nullable().optional(),
    creator_name: z.string().nullable().optional(),
    created_at: z.string().nullable().default(null),
    updated_at: z.string().nullable().default(null),
  })
  .passthrough();

export type DoltHubPullDetailT = {
  pull_id: string;
  title: string;
  description: string | null;
  state: string;
  from_branch_name: string | null;
  to_branch_name: string | null;
  from_branch_owner_name: string | null;
  from_branch_repo_name: string | null;
  creator_name: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export async function getPull(
  upstream: string,
  token: string,
  pullId: string
): Promise<DoltHubPullDetailT> {
  const { owner, db } = parseUpstream(upstream);
  const { status, data } = await doltFetch(`/${owner}/${db}/pulls/${pullId}`, token);
  if (status >= 400) {
    throw new DoltHubApiError(`Get pull ${pullId} failed (${status})`, status);
  }
  const raw = DoltHubPullDetailRaw.parse(data);
  // Normalize the two shapes DoltHub returns into one stable output.
  return {
    pull_id: raw.pull_id,
    title: raw.title,
    description: raw.description ?? null,
    state: raw.state,
    from_branch_name: raw.from_branch_name ?? raw.from_branch ?? null,
    to_branch_name: raw.to_branch_name ?? raw.to_branch ?? null,
    from_branch_owner_name: raw.from_branch_owner_name ?? raw.from_branch_owner ?? null,
    from_branch_repo_name: raw.from_branch_repo_name ?? raw.from_branch_database ?? null,
    creator_name: raw.creator_name ?? raw.author ?? null,
    created_at: raw.created_at ?? null,
    updated_at: raw.updated_at ?? null,
  };
}

// ── Create PR ──────────────────────────────────────────────────────────

const CreatePullResponse = z
  .object({
    pull_id: z.union([z.string(), z.number()]).transform(v => String(v)),
  })
  .passthrough();

/**
 * Open a pull request on `upstream` proposing to merge `fromBranch` into
 * `toBranch` (default `main`). Returns the new pull's id as a string.
 *
 * Used by admin operations that apply changes via `runWrite` on a scratch
 * branch — the scratch commit has to be merged into `main` for the change
 * to actually land, and the REST API's only path to do that is
 * open-PR → merge-PR (there is no direct branch-to-branch merge endpoint).
 */
export async function createPull(
  upstream: string,
  token: string,
  opts: {
    title: string;
    description?: string;
    fromBranch: string;
    toBranch?: string;
  }
): Promise<{ pullId: string }> {
  const { owner, db } = parseUpstream(upstream);
  const payload = {
    title: opts.title,
    description: opts.description ?? '',
    fromBranchOwnerName: owner,
    fromBranchRepoName: db,
    fromBranchName: opts.fromBranch,
    toBranchOwnerName: owner,
    toBranchRepoName: db,
    toBranchName: opts.toBranch ?? 'main',
  };
  const { status, data } = await doltFetch(`/${owner}/${db}/pulls`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (status >= 400) {
    const err = z.object({ error: z.string() }).safeParse(data);
    throw new DoltHubApiError(
      err.success ? err.data.error : `Create pull failed (${status})`,
      status
    );
  }
  const parsed = CreatePullResponse.safeParse(data);
  if (!parsed.success) {
    throw new DoltHubApiError(
      `Create pull returned unexpected shape: ${parsed.error.message}`,
      status
    );
  }
  return { pullId: parsed.data.pull_id };
}

// ── Merge PR ───────────────────────────────────────────────────────────

const MergeResponse = z
  .object({
    state: z.string().optional(),
    // DoltHub's async-merge contract: POST returns an operation_name that
    // the caller polls via GET /pulls/{id}/merge?operationName=... until
    // `done: true`. See docs/products/dolthub/api/database.md.
    operation_name: z.string().optional(),
  })
  .passthrough();

export async function mergePull(
  upstream: string,
  token: string,
  pullId: string
): Promise<{ state: string; operationName: string | null }> {
  const { owner, db } = parseUpstream(upstream);
  const { status, data } = await doltFetch(`/${owner}/${db}/pulls/${pullId}/merge`, token, {
    method: 'POST',
  });
  if (status >= 400) {
    const err = z.object({ error: z.string() }).safeParse(data);
    throw new DoltHubApiError(
      err.success ? err.data.error : `Merge pull ${pullId} failed (${status})`,
      status
    );
  }
  const parsed = MergeResponse.safeParse(data);
  // DoltHub returns PR states with inconsistent casing across endpoints
  // (`Merged` from list/detail, `merged`/`merging` from this merge endpoint).
  // Normalize to lowercase so callers can compare against a single canonical
  // value regardless of which sync/async path the API chose.
  const rawState = parsed.success && parsed.data.state ? parsed.data.state : 'merging';
  return {
    state: rawState.toLowerCase(),
    operationName: parsed.success ? (parsed.data.operation_name ?? null) : null,
  };
}

// DoltHub's merge-status poll response. `done: true` means the job has
// finished (either committed the merge, or errored — check `res_details`).
const MergeOperationStatus = z
  .object({
    done: z.boolean().default(false),
    res_details: z
      .object({
        query_execution_status: z.string().optional(),
        query_execution_message: z.string().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Poll `GET /pulls/{id}/merge?operationName=...` until the merge operation
 * completes or `timeoutMs` elapses. Required before cleaning up the source
 * branch of an auto-merge flow — deleting the branch while the async merge
 * worker is still reading it can abort the merge silently and leave the
 * target branch unchanged.
 *
 * Resolves with `{ done: true, success: boolean }`:
 *   - `success=true` means the merge committed to the target branch.
 *   - `success=false` means the job finished but DoltHub reported a
 *     query-level failure (e.g. a conflict) — inspect res_details.
 * Rejects with `DoltHubApiError` on a timeout or a transport error.
 */
export async function waitForMergeCompletion(
  upstream: string,
  token: string,
  pullId: string,
  operationName: string,
  opts: { timeoutMs?: number; pollIntervalMs?: number } = {}
): Promise<{ done: true; success: boolean }> {
  const { owner, db } = parseUpstream(upstream);
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  const path = `/${owner}/${db}/pulls/${pullId}/merge?operationName=${encodeURIComponent(operationName)}`;

  while (Date.now() < deadline) {
    const { status, data } = await doltFetch(path, token);
    if (status >= 400) {
      throw new DoltHubApiError(`Poll merge ${pullId} failed (${status})`, status);
    }
    const parsed = MergeOperationStatus.safeParse(data);
    if (parsed.success && parsed.data.done) {
      const qStatus = parsed.data.res_details?.query_execution_status;
      // DoltHub uses "Success" for healthy completion; anything else means
      // the merge job finished but didn't land on the target branch.
      const success = !qStatus || qStatus === 'Success';
      return { done: true, success };
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }

  throw new DoltHubApiError(`Timed out waiting for merge ${pullId} after ${timeoutMs}ms`, 504);
}

// ── Close PR (no merge) ────────────────────────────────────────────────

export async function closePull(
  upstream: string,
  token: string,
  pullId: string
): Promise<{ state: string }> {
  const { owner, db } = parseUpstream(upstream);
  const { status, data } = await doltFetch(`/${owner}/${db}/pulls/${pullId}`, token, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: 'closed' }),
  });
  if (status >= 400) {
    const err = z.object({ error: z.string() }).safeParse(data);
    throw new DoltHubApiError(
      err.success ? err.data.error : `Close pull ${pullId} failed (${status})`,
      status
    );
  }
  const parsed = MergeResponse.safeParse(data);
  return { state: parsed.success && parsed.data.state ? parsed.data.state : 'closed' };
}

// ── Comment on PR ──────────────────────────────────────────────────────

const CommentResponse = z
  .object({
    comment: z
      .object({ comment_id: z.union([z.string(), z.number()]).optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

/**
 * Post a comment on an upstream pull request. DoltHub supports POSTing
 * comments but does not expose a GET endpoint for reading them via REST,
 * so the UI links out for viewing and uses this for posting only.
 */
export async function commentOnPull(
  upstream: string,
  token: string,
  pullId: string,
  comment: string
): Promise<void> {
  const { owner, db } = parseUpstream(upstream);
  const { status, data } = await doltFetch(`/${owner}/${db}/pulls/${pullId}/comments`, token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comment }),
  });
  if (status >= 400) {
    const err = z.object({ error: z.string() }).safeParse(data);
    throw new DoltHubApiError(
      err.success ? err.data.error : `Comment on pull ${pullId} failed (${status})`,
      status
    );
  }
  CommentResponse.safeParse(data);
}

// ── SQL query (for admin verification & rig trust-level writes) ─────────

const SqlResponse = z
  .object({
    query_execution_status: z.string().optional(),
    query_execution_message: z.string().optional(),
    rows: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .passthrough();

export type DoltHubSqlResultT = z.infer<typeof SqlResponse>;

/**
 * Runs raw SQL against DoltHub — **the caller is responsible for escaping**.
 * DoltHub's read API has no parameterized-query surface; we send the text
 * over a URL query param. Every caller must either:
 *   - use a static SQL literal with no user input, or
 *   - validate any interpolated values against a tight regex (see the
 *     `fetch*Row` helpers in `inbox/inbox-classifier.ts` for the pattern).
 * Do not pass unvalidated user input through this function.
 */
export async function runUnsafeSql(
  upstream: string,
  token: string,
  branch: string,
  sql: string
): Promise<DoltHubSqlResultT> {
  const { owner, db } = parseUpstream(upstream);
  const path = `/${owner}/${db}/${encodeURIComponent(branch)}?q=${encodeURIComponent(sql)}`;
  const { status, data } = await doltFetch(path, token);
  if (status >= 400) {
    throw new DoltHubApiError(`SQL query failed (${status})`, status);
  }
  return SqlResponse.parse(data);
}

/**
 * Write API — creates `toBranch` forked from `fromBranch` and commits the
 * DML in one call. Used for admin operations like rig trust-level edits.
 */
export async function runWrite(
  upstream: string,
  token: string,
  fromBranch: string,
  toBranch: string,
  sql: string
): Promise<DoltHubSqlResultT> {
  const { owner, db } = parseUpstream(upstream);
  const path = `/${owner}/${db}/write/${encodeURIComponent(fromBranch)}/${encodeURIComponent(toBranch)}?q=${encodeURIComponent(sql)}`;
  const { status, data } = await doltFetch(path, token, { method: 'POST' });
  if (status >= 400) {
    throw new DoltHubApiError(`Write API failed (${status})`, status);
  }
  return SqlResponse.parse(data);
}

// ── Branch-name ↔ item mapping ─────────────────────────────────────────

/**
 * `wl` creates one PR per contribution with branch name `wl/{rig-handle}/{item-id}`.
 * Parse the branch name back out to associate a PR with a wanted item.
 */
export function parseWlBranch(branch: string | null): { rigHandle: string; itemId: string } | null {
  if (!branch) return null;
  const match = branch.match(/^wl\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { rigHandle: match[1], itemId: match[2] };
}

// ── Branch management ──────────────────────────────────────────────────

/**
 * Delete a branch on the upstream. Used to clean up scratch branches
 * created by admin probes and direct writes. Failures are swallowed —
 * the caller wants best-effort cleanup, not to fail the parent op.
 */
export async function deleteBranch(upstream: string, token: string, branch: string): Promise<void> {
  const { owner, db } = parseUpstream(upstream);
  const path = `/${owner}/${db}/branches/${encodeURIComponent(branch)}`;
  try {
    await doltFetch(path, token, { method: 'DELETE' });
  } catch {
    // best-effort
  }
}

// ── Concurrency helper ─────────────────────────────────────────────────

/**
 * Map with a bounded concurrency pool. Useful for batch DoltHub calls
 * (e.g. fetching detail for N pull requests) where `Promise.all` on the
 * whole list would hammer the API and blow past Cloudflare's subrequest
 * budget.
 */
export async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  // Tag each item with its original index so workers can consume from a
  // shared queue without needing to write into a pre-allocated array.
  const indexed: Array<{ value: T; index: number }> = items.map((value, index) => ({
    value,
    index,
  }));
  const results: Array<{ index: number; result: R }> = [];
  async function worker(): Promise<void> {
    while (true) {
      const next = indexed.shift();
      if (!next) return;
      const result = await fn(next.value, next.index);
      results.push({ index: next.index, result });
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  results.sort((a, b) => a.index - b.index);
  return results.map(r => r.result);
}
