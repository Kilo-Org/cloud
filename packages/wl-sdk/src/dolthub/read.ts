/**
 * DoltHub read API — `GET /{owner}/{db}[/{ref}]?q=...`.
 *
 * Implements the **anonymous-read fallback**: if a token-authenticated
 * request returns 404, a 4xx body containing `"no such repository"`, or
 * DoltHub's branchless-read `"must include a refName"` error, retry the
 * same request anonymously. This works around DoltHub's habit of returning
 * auth-path-only errors when a token reads a public repo whose identity it
 * doesn't own. Mirrors `doGet` in `wasteland/internal/backend/remote.go`
 * plus the branchless-read behavior observed in the TypeScript SDK path.
 */

import { z } from 'zod';
import {
  type DoltHubAuth,
  type DoltFetchHooks,
  buildDoltUrl,
  doltFetch,
  WlDoltHubError,
} from './api';

const DoltReadResponse = z
  .object({
    query_execution_status: z.string().optional(),
    query_execution_message: z.string().optional(),
    rows: z.array(z.unknown()).optional(),
    schema: z.unknown().optional(),
  })
  .passthrough();

export type DoltReadResult = {
  rows: unknown[];
  schema: unknown;
  queryExecutionStatus: string;
  queryExecutionMessage: string;
  /** True if the request was served anonymously (after a token retry). */
  servedAnonymously: boolean;
};

export type DoltReadOptions = {
  auth: DoltHubAuth;
  owner: string;
  db: string;
  /** Optional ref (branch name, commit hash, tag). When absent, DoltHub
   *  uses the default branch. Anonymous reads on token-authed branchless
   *  calls work; token-authed branchless calls trip a 400. */
  ref?: string;
  query: string;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

/**
 * Decide whether a failed authenticated read is worth retrying without
 * the auth header. Mirrors `shouldRetryAnonymously` in remote.go:
 *   - HTTP 404 always retries.
 *   - any 4xx whose body contains `"no such repository"` retries.
 *   - any 4xx whose body contains `"must include a refName"` retries;
 *     DoltHub requires refs on token-authenticated reads but accepts the
 *     same public-repo read anonymously.
 * 5xx never retries (transient upstream failure).
 */
export function shouldRetryAnonymously(status: number, body: unknown, text: string): boolean {
  if (status === 404) return true;
  if (status < 400 || status >= 500) return false;
  const haystack = typeof body === 'string' ? body : text;
  return /no such repository/i.test(haystack) || /must include a refName/i.test(haystack);
}

function buildReadPath(owner: string, db: string, ref: string | undefined): string {
  const base = `/${encodeURIComponent(owner)}/${encodeURIComponent(db)}`;
  return ref ? `${base}/${encodeURIComponent(ref)}` : base;
}

/**
 * Run a SELECT against DoltHub. With a token, retries anonymously on
 * the documented 404 / "no such repository" paths.
 *
 * Throws `WlDoltHubError` on:
 *   - any 5xx,
 *   - a 4xx that doesn't trigger anonymous fallback,
 *   - a 4xx where anonymous fallback also fails (the original error
 *     is surfaced),
 *   - a malformed response body.
 */
export async function doltRead(opts: DoltReadOptions): Promise<DoltReadResult> {
  const path = buildReadPath(opts.owner, opts.db, opts.ref);
  const query = { q: opts.query };

  const first = await doltFetch({
    method: 'GET',
    path,
    auth: opts.auth,
    query,
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
  const url = buildDoltUrl(path, query);

  if (first.status >= 200 && first.status < 300) {
    return parseReadResult(first.json, url, false);
  }

  const hasToken = 'token' in opts.auth;
  if (hasToken && shouldRetryAnonymously(first.status, first.json, first.text)) {
    const retry = await doltFetch({
      method: 'GET',
      path,
      auth: { anonymous: true },
      query,
      fetch: opts.fetch,
      hooks: opts.hooks,
    });
    if (retry.status >= 200 && retry.status < 300) {
      return parseReadResult(retry.json, url, true);
    }
    // Fallthrough: surface the *original* error so callers see the
    // auth-path failure, not the anonymous retry's masked one.
  }

  throw new WlDoltHubError(
    `Read on ${opts.owner}/${opts.db} failed (${first.status})`,
    first.status,
    first.json ?? first.text,
    url
  );
}

function parseReadResult(raw: unknown, url: string, servedAnonymously: boolean): DoltReadResult {
  const parsed = DoltReadResponse.safeParse(raw);
  if (!parsed.success) {
    throw new WlDoltHubError(
      `Read returned an unexpected shape: ${parsed.error.message}`,
      200,
      raw,
      url
    );
  }
  return {
    rows: parsed.data.rows ?? [],
    schema: parsed.data.schema,
    queryExecutionStatus: parsed.data.query_execution_status ?? '',
    queryExecutionMessage: parsed.data.query_execution_message ?? '',
    servedAnonymously,
  };
}
