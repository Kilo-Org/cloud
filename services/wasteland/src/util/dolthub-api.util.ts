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

type DoltFetchInit = Omit<RequestInit, 'headers'> & { headers?: Record<string, string> };

async function doltFetch(
  path: string,
  token: string,
  init?: DoltFetchInit
): Promise<{ status: number; data: unknown }> {
  const res = await fetch(`${DOLTHUB_API_BASE}${path}`, {
    ...init,
    headers: {
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

// ── Merge PR ───────────────────────────────────────────────────────────

const MergeResponse = z
  .object({
    state: z.string().optional(),
  })
  .passthrough();

export async function mergePull(
  upstream: string,
  token: string,
  pullId: string
): Promise<{ state: string }> {
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
  return { state: parsed.success && parsed.data.state ? parsed.data.state : 'merging' };
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

export async function runSql(
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
