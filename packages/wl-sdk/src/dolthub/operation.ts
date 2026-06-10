/**
 * DoltHub long-running operation polling.
 *
 * Write API and merge calls return either a synchronous result or an
 * `operation_name` to poll. This module owns the polling loop:
 * exponential backoff (capped at 8s), 5 consecutive transport errors
 * fail fast, 4xx during poll fail fast (with the documented
 * `sqlwrite.toCommitId` bare-text-vs-JSON-error quirk handled), 5xx
 * retried until timeout.
 *
 * Mirrors `pollWriteOperation` in
 * `services/wasteland/src/upstream-bootstrap/dolthub-write.ts`.
 */

import { z } from 'zod';
import {
  type DoltHubAuth,
  type DoltFetchHooks,
  buildDoltUrl,
  doltFetch,
  WlDoltHubError,
} from './api';

const PollResponse = z
  .object({
    done: z.boolean().default(false),
    res_details: z
      .object({
        query_execution_status: z.string().optional(),
        query_execution_message: z.string().optional(),
        from_commit_id: z.string().nullable().optional(),
        to_commit_id: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    // Some legacy responses surface these at the top level.
    query_execution_status: z.string().optional(),
    query_execution_message: z.string().optional(),
  })
  .passthrough();

// Fork operation poll has a different shape than write/merge. Per
// `pollForkOperation` in `wasteland/internal/remote/dolthub.go`, fork
// returns `{status, owner_name, database_name}`; the operation is
// considered complete when `owner_name + database_name` are populated
// or `status` ∈ {success, done, completed}. Falls back to the
// write/merge `done`/`res_details` shape so a single function handles
// both.
const ForkPollResponse = z
  .object({
    status: z.string().optional(),
    owner_name: z.string().optional(),
    database_name: z.string().optional(),
  })
  .passthrough();

export type PollOperationResult = {
  /** True iff DoltHub produced a real new commit (toCommitId !== fromCommitId). */
  committed: boolean;
  fromCommitId: string | null;
  toCommitId: string | null;
  /** DoltHub's `query_execution_status` from the polled operation. */
  status: string;
  /** DoltHub's `query_execution_message`. Often empty on success. */
  message: string;
};

export type PollOperationOptions = {
  auth: DoltHubAuth;
  owner: string;
  db: string;
  operationName: string;
  /** Endpoint kind. Defaults to `'write'` — controls the path
   *  segment used for polling (`/write?operationName=…` for write,
   *  `/pulls/{id}/merge?operationName=…` for merge, `/fork?operationName=…`
   *  for fork). */
  endpoint?: 'write' | 'merge' | 'fork';
  /** Pull id, required when `endpoint: 'merge'`. */
  pullId?: string;
  /** Initial backoff in ms. Defaults to 500ms. */
  initialBackoffMs?: number;
  /** Maximum backoff in ms. Defaults to 8000ms. */
  maxBackoffMs?: number;
  /** Total polling timeout in ms. Defaults to 120_000 (2 minutes). */
  timeoutMs?: number;
  /** Inject sleep for tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildPollPath(opts: PollOperationOptions): string {
  const owner = encodeURIComponent(opts.owner);
  const db = encodeURIComponent(opts.db);
  const kind = opts.endpoint ?? 'write';
  if (kind === 'fork') {
    return `/fork`;
  }
  if (kind === 'merge') {
    if (!opts.pullId) {
      throw new WlDoltHubError(
        'pollOperation: pullId is required when endpoint=merge',
        0,
        null,
        ''
      );
    }
    return `/${owner}/${db}/pulls/${encodeURIComponent(opts.pullId)}/merge`;
  }
  return `/${owner}/${db}/write`;
}

/**
 * Poll the DoltHub operation endpoint until it completes or `timeoutMs`
 * elapses. Resolves with the final commit IDs and DoltHub's status/
 * message; throws `WlDoltHubError` on failure or timeout.
 */
export async function pollOperation(opts: PollOperationOptions): Promise<PollOperationResult> {
  const sleep = opts.sleep ?? defaultSleep;
  const initialBackoffMs = opts.initialBackoffMs ?? 500;
  const maxBackoffMs = opts.maxBackoffMs ?? 8_000;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let backoffMs = initialBackoffMs;
  const deadline = Date.now() + timeoutMs;
  let consecutiveErrors = 0;
  let lastError: string | null = null;

  const path = buildPollPath(opts);
  const query = { operationName: opts.operationName };
  const url = buildDoltUrl(path, query);

  while (Date.now() < deadline) {
    await sleep(backoffMs);

    let res: Awaited<ReturnType<typeof doltFetch>>;
    try {
      res = await doltFetch({
        method: 'GET',
        path,
        auth: opts.auth,
        query,
        fetch: opts.fetch,
        hooks: opts.hooks,
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Transport-level surface of the same "no commit produced" signal
      // that the 400 path catches below.
      if (/sqlwrite\.tocommitid/i.test(lastError)) {
        return {
          committed: false,
          fromCommitId: null,
          toCommitId: null,
          status: '',
          message: lastError,
        };
      }
      consecutiveErrors++;
      if (consecutiveErrors >= 5) {
        throw new WlDoltHubError(
          `Polling operation ${opts.operationName} failed: ${lastError}`,
          502,
          null,
          url
        );
      }
      if (backoffMs < maxBackoffMs) backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      continue;
    }

    if (res.status >= 400) {
      const lower = res.text.toLowerCase();

      // HTTP 400 mentioning `sqlwrite.toCommitId` has two flavors:
      //   1. **Benign no-op** — bare error text, no `query_execution_status`
      //      envelope. The SQL ran but produced no commit (e.g.
      //      `INSERT IGNORE` against an existing row).
      //   2. **Real DoltHub error** — JSON envelope with
      //      `query_execution_status: "Error"` and a meaningful message.
      // Inspect the JSON body to distinguish.
      if (res.status === 400 && lower.includes('sqlwrite.tocommitid')) {
        const errParsed = z
          .object({
            query_execution_status: z.string().optional(),
            query_execution_message: z.string().optional(),
          })
          .passthrough()
          .safeParse(res.json ?? {});
        const status = errParsed.success ? (errParsed.data.query_execution_status ?? '') : '';
        if (status.toLowerCase() === 'error') {
          throw new WlDoltHubError(
            `Operation ${opts.operationName} failed: ${
              errParsed.success
                ? (errParsed.data.query_execution_message ?? 'unknown error')
                : 'unknown error'
            }`,
            400,
            res.json ?? res.text,
            url
          );
        }
        return {
          committed: false,
          fromCommitId: null,
          toCommitId: null,
          status: '',
          message: res.text.slice(0, 400),
        };
      }

      lastError = `HTTP ${res.status}${res.text ? `: ${res.text.slice(0, 400)}` : ''}`;
      const failFast = res.status >= 400 && res.status < 500;
      consecutiveErrors++;
      if (failFast || consecutiveErrors >= 5) {
        throw new WlDoltHubError(
          `Polling operation ${opts.operationName} failed: ${lastError}`,
          res.status,
          res.json ?? res.text,
          url
        );
      }
      if (backoffMs < maxBackoffMs) backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      continue;
    }
    consecutiveErrors = 0;

    // Fork operation: its poll body uses `{status, owner_name,
    // database_name}` rather than the write/merge `done` / `res_details`
    // shape. Recognize completion via either populated owner+database
    // pair or a terminal status field.
    if ((opts.endpoint ?? 'write') === 'fork') {
      const forkParsed = ForkPollResponse.safeParse(res.json ?? {});
      if (forkParsed.success) {
        const { status: forkStatus, owner_name, database_name } = forkParsed.data;
        if (owner_name && database_name) {
          return {
            committed: true,
            fromCommitId: null,
            toCommitId: null,
            status: 'Success',
            message: '',
          };
        }
        const lower = (forkStatus ?? '').toLowerCase();
        if (lower === 'success' || lower === 'done' || lower === 'completed') {
          return {
            committed: true,
            fromCommitId: null,
            toCommitId: null,
            status: forkStatus ?? '',
            message: '',
          };
        }
      }
      if (backoffMs < maxBackoffMs) backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
      continue;
    }

    const parsed = PollResponse.safeParse(res.json ?? {});
    if (parsed.success) {
      const status =
        parsed.data.res_details?.query_execution_status ?? parsed.data.query_execution_status ?? '';
      const message =
        parsed.data.res_details?.query_execution_message ??
        parsed.data.query_execution_message ??
        '';
      const fromCommitId = parsed.data.res_details?.from_commit_id ?? null;
      const toCommitId = parsed.data.res_details?.to_commit_id ?? null;
      const committed = !!(toCommitId && toCommitId !== fromCommitId);

      const lower = status.toLowerCase();
      if (lower === 'error') {
        throw new WlDoltHubError(
          `Operation ${opts.operationName} failed: ${message || 'unknown error'}`,
          400,
          res.json,
          url
        );
      }
      if (lower === 'success' || lower === 'successwithwarning') {
        return { committed, fromCommitId, toCommitId, status, message };
      }
      if (parsed.data.done) {
        if (status === '') {
          throw new WlDoltHubError(
            `Operation ${opts.operationName} finished with unknown status`,
            500,
            res.json,
            url
          );
        }
        return { committed, fromCommitId, toCommitId, status, message };
      }
    }

    if (backoffMs < maxBackoffMs) backoffMs = Math.min(backoffMs * 2, maxBackoffMs);
  }

  throw new WlDoltHubError(
    `Timed out waiting for operation ${opts.operationName}` +
      (lastError ? ` (last error: ${lastError})` : ''),
    504,
    null,
    url
  );
}
