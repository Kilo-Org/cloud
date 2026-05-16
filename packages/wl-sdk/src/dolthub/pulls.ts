/**
 * DoltHub pull-request lifecycle.
 *
 *   GET    /{owner}/{db}/pulls
 *   GET    /{owner}/{db}/pulls/{id}
 *   POST   /{owner}/{db}/pulls                     — create
 *   PATCH  /{owner}/{db}/pulls/{id}                — close (state=closed)
 *   POST   /{owner}/{db}/pulls/{id}/merge          — sync or async merge
 *   POST   /{owner}/{db}/pulls/{id}/comments       — add comment
 *
 * DoltHub returns PR detail with two competing field-name shapes; we
 * accept both at parse time and emit a single normalized output.
 * State filtering is done client-side because DoltHub ignores the
 * `state` query parameter server-side.
 */

import { z } from 'zod';
import {
  type DoltHubAuth,
  type DoltFetchHooks,
  doltFetch,
  expectOk,
  buildDoltUrl,
  WlDoltHubError,
} from './api';

const PullSummary = z
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

const ListPullsResponse = z
  .object({
    pulls: z.array(PullSummary).default([]),
  })
  .passthrough();

const PullDetailRaw = z
  .object({
    pull_id: z.union([z.string(), z.number()]).transform(v => String(v)),
    title: z.string().default(''),
    description: z.string().nullable().default(null),
    state: z.string(),
    from_branch: z.string().nullable().optional(),
    from_branch_name: z.string().nullable().optional(),
    to_branch: z.string().nullable().optional(),
    to_branch_name: z.string().nullable().optional(),
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

const CreatePullResponse = z
  .object({
    pull_id: z.union([z.string(), z.number()]).transform(v => String(v)),
  })
  .passthrough();

const MergeResponse = z
  .object({
    state: z.string().optional(),
    operation_name: z.string().optional(),
  })
  .passthrough();

export type Pull = z.infer<typeof PullSummary>;

export type PullDetail = {
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

export type PullState = 'open' | 'closed' | 'merged' | 'all';

type CommonOpts = {
  auth: DoltHubAuth;
  owner: string;
  db: string;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

export type ListPullsOptions = CommonOpts & { state?: PullState };
export type GetPullOptions = CommonOpts & { pullId: string };
export type CreatePullOptions = CommonOpts & {
  title: string;
  description?: string;
  fromBranch: string;
  toBranch?: string;
  /** Owner of the source repo (for fork-based PRs). Defaults to `owner`. */
  fromOwner?: string;
  /** Database name of the source repo. Defaults to `db`. */
  fromDb?: string;
};
export type ClosePullOptions = CommonOpts & { pullId: string };
export type MergePullOptions = CommonOpts & { pullId: string };
export type CommentOnPullOptions = CommonOpts & { pullId: string; body: string };

export type MergePullResult = {
  /** Lowercased state — DoltHub returns inconsistent casing across endpoints. */
  state: string;
  /** Present iff the merge is async; pass to `pollOperation({ endpoint: 'merge' })`. */
  operationName: string | null;
};

function pullsPath(owner: string, db: string): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(db)}/pulls`;
}

/** List pulls on `owner/db`, optionally filtered by state (client-side). */
export async function listPulls(opts: ListPullsOptions): Promise<Pull[]> {
  const path = pullsPath(opts.owner, opts.db);
  const res = await doltFetch({
    method: 'GET',
    path,
    auth: opts.auth,
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
  expectOk(res, buildDoltUrl(path), `List pulls on ${opts.owner}/${opts.db}`);
  const parsed = ListPullsResponse.safeParse(res.json ?? {});
  if (!parsed.success) return [];
  const pulls = parsed.data.pulls;
  if (!opts.state || opts.state === 'all') return pulls;
  const want = opts.state.toLowerCase();
  return pulls.filter(p => p.state.toLowerCase() === want);
}

/** Fetch pull detail, normalizing the dual field-name shapes. */
export async function getPull(opts: GetPullOptions): Promise<PullDetail> {
  const path = `${pullsPath(opts.owner, opts.db)}/${encodeURIComponent(opts.pullId)}`;
  const res = await doltFetch({
    method: 'GET',
    path,
    auth: opts.auth,
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
  const url = buildDoltUrl(path);
  expectOk(res, url, `Get pull ${opts.pullId}`);
  const parsed = PullDetailRaw.safeParse(res.json ?? {});
  if (!parsed.success) {
    throw new WlDoltHubError(
      `Get pull ${opts.pullId} returned an unexpected shape: ${parsed.error.message}`,
      res.status,
      res.json ?? res.text,
      url
    );
  }
  const raw = parsed.data;
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

/**
 * Open a pull request. `fromOwner` / `fromDb` default to `owner` /
 * `db` so the same-repo branch-to-branch case (the common one) needs
 * only `fromBranch` + `toBranch`.
 */
export async function createPull(opts: CreatePullOptions): Promise<{ pullId: string }> {
  const path = pullsPath(opts.owner, opts.db);
  const payload = {
    title: opts.title,
    description: opts.description ?? '',
    fromBranchOwnerName: opts.fromOwner ?? opts.owner,
    fromBranchRepoName: opts.fromDb ?? opts.db,
    fromBranchName: opts.fromBranch,
    toBranchOwnerName: opts.owner,
    toBranchRepoName: opts.db,
    toBranchName: opts.toBranch ?? 'main',
  };
  const res = await doltFetch({
    method: 'POST',
    path,
    auth: opts.auth,
    body: payload,
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
  const url = buildDoltUrl(path);
  expectOk(res, url, `Create pull on ${opts.owner}/${opts.db}`);
  const parsed = CreatePullResponse.safeParse(res.json ?? {});
  if (!parsed.success) {
    throw new WlDoltHubError(
      `Create pull on ${opts.owner}/${opts.db} returned an unexpected shape: ${parsed.error.message}`,
      res.status,
      res.json ?? res.text,
      url
    );
  }
  return { pullId: parsed.data.pull_id };
}

/** Close a pull (without merging). */
export async function closePull(opts: ClosePullOptions): Promise<{ state: string }> {
  const path = `${pullsPath(opts.owner, opts.db)}/${encodeURIComponent(opts.pullId)}`;
  const res = await doltFetch({
    method: 'PATCH',
    path,
    auth: opts.auth,
    body: { state: 'closed' },
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
  expectOk(res, buildDoltUrl(path), `Close pull ${opts.pullId}`);
  const parsed = MergeResponse.safeParse(res.json ?? {});
  return { state: parsed.success && parsed.data.state ? parsed.data.state : 'closed' };
}

/**
 * Trigger a merge. The result may be synchronous (`state: 'merged'`,
 * no operationName) or async (`operationName` set). Callers pass the
 * operationName to `pollOperation({ endpoint: 'merge', pullId })` for
 * the async path.
 */
export async function mergePull(opts: MergePullOptions): Promise<MergePullResult> {
  const path = `${pullsPath(opts.owner, opts.db)}/${encodeURIComponent(opts.pullId)}/merge`;
  const res = await doltFetch({
    method: 'POST',
    path,
    auth: opts.auth,
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
  expectOk(res, buildDoltUrl(path), `Merge pull ${opts.pullId}`);
  const parsed = MergeResponse.safeParse(res.json ?? {});
  const rawState = parsed.success && parsed.data.state ? parsed.data.state : 'merging';
  return {
    state: rawState.toLowerCase(),
    operationName: parsed.success ? (parsed.data.operation_name ?? null) : null,
  };
}

/** Post a comment on a pull. */
export async function commentOnPull(opts: CommentOnPullOptions): Promise<void> {
  const path = `${pullsPath(opts.owner, opts.db)}/${encodeURIComponent(opts.pullId)}/comments`;
  const res = await doltFetch({
    method: 'POST',
    path,
    auth: opts.auth,
    body: { comment: opts.body },
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
  expectOk(res, buildDoltUrl(path), `Comment on pull ${opts.pullId}`);
}
