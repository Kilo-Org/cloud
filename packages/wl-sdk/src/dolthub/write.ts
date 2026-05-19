/**
 * DoltHub write API.
 *
 *     POST /{owner}/{db}/write/{from}/{to}?q=<SQL>
 *
 * Returns either a synchronous result (no `operation_name`, used for
 * statements that didn't produce a new commit) or an async envelope
 * with an `operation_name` to poll. This module dispatches the POST,
 * branches on the shape, and (when async) delegates to `pollOperation`.
 *
 * An empty `query` issues a branch-merge: per DoltHub's docs, hitting
 * the write endpoint with no `q` merges `from` into `to`.
 */

import { z } from 'zod';
import {
  type DoltHubAuth,
  type DoltFetchHooks,
  buildDoltUrl,
  doltFetch,
  WlDoltHubError,
} from './api';
import { pollOperation, type PollOperationResult } from './operation';

const WriteResponse = z
  .object({
    operation_name: z.string().optional(),
    query_execution_status: z.string().optional(),
    query_execution_message: z.string().optional(),
  })
  .passthrough();

export type DoltWriteResult = PollOperationResult;

export type DoltWriteOptions = {
  auth: DoltHubAuth;
  owner: string;
  db: string;
  fromBranch: string;
  toBranch: string;
  /** SQL to execute. Empty string issues a branch-merge per DoltHub docs. */
  query: string;
  /** Polling timeout. Defaults to 2 minutes. */
  timeoutMs?: number;
  /** Polling interval (initial backoff). Defaults to 500ms. */
  initialBackoffMs?: number;
  /** Inject sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

/**
 * Issue a single write against DoltHub and (when async) poll the
 * resulting operation to completion. Returns the final commit IDs and
 * status; throws `WlDoltHubError` on non-2xx POST or polling failure.
 *
 * `from === to` walks the branch tip forward; `from !== to` either
 * creates `to` from `from` (when `to` doesn't exist) or commits onto
 * `to` parented from `from`.
 */
export async function doltWrite(opts: DoltWriteOptions): Promise<DoltWriteResult> {
  const owner = encodeURIComponent(opts.owner);
  const db = encodeURIComponent(opts.db);
  const from = encodeURIComponent(opts.fromBranch);
  const to = encodeURIComponent(opts.toBranch);
  const path = `/${owner}/${db}/write/${from}/${to}`;
  // Empty-query is intentional for the branch-merge case — pass it as
  // an explicit empty string rather than undefined so DoltHub sees `?q=`.
  const query: Record<string, string | undefined> = {};
  if (opts.query !== '') query.q = opts.query;

  const res = await doltFetch({
    method: 'POST',
    path,
    auth: opts.auth,
    query,
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
  const url = buildDoltUrl(path, query);

  if (res.status < 200 || res.status >= 300) {
    throw new WlDoltHubError(
      `Write API failed (${res.status}) for ${opts.owner}/${opts.db}`,
      res.status,
      res.json ?? res.text,
      url
    );
  }

  const parsed = WriteResponse.safeParse(res.json ?? {});
  if (!parsed.success) {
    throw new WlDoltHubError(
      `Write API returned an unexpected shape: ${parsed.error.message}`,
      res.status,
      res.json ?? res.text,
      url
    );
  }
  const data = parsed.data;
  if (data.query_execution_status === 'Error') {
    throw new WlDoltHubError(
      `Write operation failed: ${data.query_execution_message ?? 'unknown error'}`,
      400,
      res.json,
      url
    );
  }

  // Synchronous success — no operation_name to poll. With no commit
  // info available, conservatively report committed=false.
  if (!data.operation_name) {
    return {
      committed: false,
      fromCommitId: null,
      toCommitId: null,
      status: data.query_execution_status ?? '',
      message: data.query_execution_message ?? '',
    };
  }

  return pollOperation({
    auth: opts.auth,
    owner: opts.owner,
    db: opts.db,
    operationName: data.operation_name,
    endpoint: 'write',
    timeoutMs: opts.timeoutMs,
    initialBackoffMs: opts.initialBackoffMs,
    sleep: opts.sleep,
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
}
