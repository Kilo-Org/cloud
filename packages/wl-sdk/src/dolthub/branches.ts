/**
 * DoltHub branch CRUD.
 *
 *   GET    /{owner}/{db}/branches            — list
 *   POST   /{owner}/{db}/branches            — create from base
 *   DELETE /{owner}/{db}/branches/{name}     — delete
 *
 * `branchExists` is a convenience over `listBranches`. The Go SDK
 * exposes a dedicated branch-name lookup but DoltHub's REST surface
 * doesn't, so we filter the list client-side.
 */

import { z } from 'zod';
import { type DoltHubAuth, type DoltFetchHooks, doltFetch, expectOk, buildDoltUrl } from './api';
import { WlDoltHubError } from './api';

const BranchSchema = z
  .object({
    branch_name: z.string(),
    latest_committer: z.string().optional(),
    latest_commit_message: z.string().optional(),
    latest_commit_date: z.string().optional(),
  })
  .passthrough();

const ListBranchesResponse = z
  .object({
    status: z.string().optional(),
    branches: z.array(BranchSchema).default([]),
  })
  .passthrough();

const CreateBranchResponse = z
  .object({
    status: z.string().optional(),
    message: z.string().optional(),
    new_branch_name: z.string().optional(),
  })
  .passthrough();

export type Branch = z.infer<typeof BranchSchema>;

type CommonOpts = {
  auth: DoltHubAuth;
  owner: string;
  db: string;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

export type ListBranchesOptions = CommonOpts;
export type BranchExistsOptions = CommonOpts & { branch: string };
export type DeleteBranchOptions = CommonOpts & { branch: string };
export type CreateBranchOptions = CommonOpts & {
  fromBranch: string;
  toBranch: string;
};

function branchesPath(owner: string, db: string): string {
  return `/${encodeURIComponent(owner)}/${encodeURIComponent(db)}/branches`;
}

/** List branches on `owner/db`. Throws `WlDoltHubError` on non-2xx. */
export async function listBranches(opts: ListBranchesOptions): Promise<Branch[]> {
  const path = branchesPath(opts.owner, opts.db);
  const res = await doltFetch({
    method: 'GET',
    path,
    auth: opts.auth,
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
  const url = buildDoltUrl(path);
  expectOk(res, url, `List branches on ${opts.owner}/${opts.db}`);
  const parsed = ListBranchesResponse.safeParse(res.json ?? {});
  if (!parsed.success) return [];
  return parsed.data.branches;
}

/**
 * Check whether `branch` exists on `owner/db`. Returns `false` on
 * any error (`listBranches` throws are swallowed) so callers can
 * use this as a probe without try/catch.
 */
export async function branchExists(opts: BranchExistsOptions): Promise<boolean> {
  try {
    const branches = await listBranches({
      auth: opts.auth,
      owner: opts.owner,
      db: opts.db,
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
    return branches.some(b => b.branch_name === opts.branch);
  } catch {
    return false;
  }
}

/** Delete `branch` on `owner/db`. Throws `WlDoltHubError` on non-2xx. */
export async function deleteBranch(opts: DeleteBranchOptions): Promise<void> {
  const path = `${branchesPath(opts.owner, opts.db)}/${encodeURIComponent(opts.branch)}`;
  const res = await doltFetch({
    method: 'DELETE',
    path,
    auth: opts.auth,
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
  expectOk(res, buildDoltUrl(path), `Delete branch ${opts.branch} on ${opts.owner}/${opts.db}`);
}

/**
 * Create `toBranch` on `owner/db`, forked from `fromBranch`.
 * Idempotent: a 4xx response with "already exists" / "duplicate" in
 * the message resolves successfully.
 */
export async function createBranch(opts: CreateBranchOptions): Promise<void> {
  const path = branchesPath(opts.owner, opts.db);
  const body = {
    revisionType: 'branch',
    revisionName: opts.fromBranch,
    newBranchName: opts.toBranch,
  };
  const res = await doltFetch({
    method: 'POST',
    path,
    auth: opts.auth,
    body,
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
  const url = buildDoltUrl(path);
  const parsed = CreateBranchResponse.safeParse(res.json ?? {});
  const message = parsed.success ? (parsed.data.message ?? '') : '';
  const statusField = parsed.success ? (parsed.data.status ?? '') : '';
  const isErrorEnvelope = /^error$/i.test(statusField);

  if (res.status >= 200 && res.status < 300 && !isErrorEnvelope) return;
  if (/already exists|duplicate/i.test(message)) return;

  throw new WlDoltHubError(
    `Create branch ${opts.toBranch} on ${opts.owner}/${opts.db} failed (${res.status}): ${
      message || res.text || 'no error body'
    }`,
    res.status,
    res.json ?? res.text,
    url
  );
}
