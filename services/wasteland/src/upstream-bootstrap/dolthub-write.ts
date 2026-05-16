/**
 * Thin wrapper around DoltHub's database-create and write APIs, used by
 * `create-upstream.ts` to bootstrap a brand-new commons repo entirely
 * from the worker.
 *
 * Both `createDatabase` and `execWrite` mirror the polling shape of
 * `RemoteDB.execOne` / `pollOperation` in
 * `wasteland/internal/backend/remote.go`. Any divergence in the
 * upstream's polling contract should be propagated here verbatim.
 *
 * Note: `runWrite` in `util/dolthub-api.util.ts` issues the same write
 * call but does **not** poll the resulting `operation_name`. For
 * schema-bootstrap we need each statement to be fully committed before
 * the next is dispatched, so this module owns the polling.
 */
import { z } from 'zod';
import { DOLTHUB_API_BASE, DoltHubApiError } from '../util/dolthub-api.util';

// ── Database creation ─────────────────────────────────────────────────

// DoltHub's create-database response. The 200 envelope exposes
// `status: 'Success'` plus echoed metadata; the 400 envelope exposes
// `status: 'Error'` and a human-readable `message` (e.g.
// "private repos require a paid DoltHub account"). We accept both
// `message` and `error` keys because some upstream endpoints have
// historically used `error` instead — keeping the union avoids
// re-debugging if DoltHub renames it again.
const CreateDatabaseResponse = z
  .object({
    status: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
    repository_owner: z.string().optional(),
    repository_name: z.string().optional(),
  })
  .passthrough();

/**
 * Create a new DoltHub database. Returns `{ created: true }` on a fresh
 * create, `{ created: false }` if the repo already existed (idempotent).
 *
 * Endpoint: `POST /api/v1alpha1/database` with body
 * `{ ownerName, repoName, visibility, description? }`. Schema mirrors
 * the OpenAPI spec embedded in the DoltHub docs (`createDatabase.json`).
 *
 * `visibility` defaults to `'public'` because:
 *   - DoltHub's free tier only allows public databases — sending
 *     `'private'` from a free account fails with HTTP 400.
 *   - The wasteland commons schema is collaborative by design; private
 *     should be an explicit opt-in by the caller, not the implicit
 *     default.
 */
export async function createDatabase(
  token: string,
  opts: {
    owner: string;
    db: string;
    visibility?: 'public' | 'private';
    description?: string;
  }
): Promise<{ created: boolean }> {
  const url = `${DOLTHUB_API_BASE}/database`;
  const body = {
    ownerName: opts.owner,
    repoName: opts.db,
    visibility: opts.visibility ?? 'public',
    ...(opts.description ? { description: opts.description } : {}),
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cache-control': 'no-cache',
      authorization: `token ${token}`,
    },
    body: JSON.stringify(body),
  });
  const raw: unknown = await res.json().catch(() => ({}));
  const parsed = CreateDatabaseResponse.safeParse(raw);
  const message = parsed.success ? (parsed.data.message ?? parsed.data.error ?? '') : '';

  if (res.status === 409) {
    return { created: false };
  }
  // DoltHub returns 200 with `status: 'Error'` on some failure modes
  // (notably "already exists") and 4xx on others. Branch on both the
  // HTTP status and the body envelope so we don't miss either path.
  const statusField = parsed.success ? (parsed.data.status ?? '') : '';
  const isErrorEnvelope = /^error$/i.test(statusField);
  if (res.ok && !isErrorEnvelope) {
    return { created: true };
  }
  if (/already exists|duplicate/i.test(message)) {
    return { created: false };
  }
  throw new DoltHubApiError(
    `Create database ${opts.owner}/${opts.db} failed (${res.status}): ${message || res.statusText || 'no error body'}`,
    res.status
  );
}

// ── Branch management ─────────────────────────────────────────────────

const ListBranchesResponse = z
  .object({
    status: z.string().optional(),
    branches: z.array(z.object({ branch_name: z.string() }).passthrough()).default([]),
  })
  .passthrough();

/**
 * List branch names on a DoltHub database. Returns just the names so
 * callers don't have to thread DoltHub's row shape around.
 */
export async function listBranches(
  token: string,
  opts: { owner: string; db: string }
): Promise<string[]> {
  const url = `${DOLTHUB_API_BASE}/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.db)}/branches`;
  const res = await fetch(url, {
    headers: {
      'cache-control': 'no-cache',
      authorization: `token ${token}`,
    },
  });
  const raw: unknown = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new DoltHubApiError(
      `List branches on ${opts.owner}/${opts.db} failed (${res.status}): ${JSON.stringify(raw).slice(0, 200)}`,
      res.status
    );
  }
  const parsed = ListBranchesResponse.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.branches.map(b => b.branch_name);
}

const CreateBranchResponse = z
  .object({
    status: z.string().optional(),
    message: z.string().optional(),
    new_branch_name: z.string().optional(),
  })
  .passthrough();

/**
 * Create a branch on a DoltHub database. Idempotent: a 4xx response
 * with "already exists" in the message resolves to `{ created: false }`.
 *
 * Used by the bootstrap to explicitly create the scratch branch before
 * any writes — DoltHub's write API documents that it will create
 * `to_branch` on demand from `from_branch`, but observation in
 * production showed the implicit-create path silently no-ops on a
 * freshly-created database. Calling this endpoint up-front avoids
 * relying on the write API's branch-creation side effect.
 */
export async function createBranch(
  token: string,
  opts: { owner: string; db: string; baseBranch: string; newBranch: string }
): Promise<{ created: boolean }> {
  const url = `${DOLTHUB_API_BASE}/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.db)}/branches`;
  const body = {
    revisionType: 'branch',
    revisionName: opts.baseBranch,
    newBranchName: opts.newBranch,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'cache-control': 'no-cache',
      authorization: `token ${token}`,
    },
    body: JSON.stringify(body),
  });
  const raw: unknown = await res.json().catch(() => ({}));
  const parsed = CreateBranchResponse.safeParse(raw);
  const message = parsed.success ? (parsed.data.message ?? '') : '';
  const statusField = parsed.success ? (parsed.data.status ?? '') : '';
  const isErrorEnvelope = /^error$/i.test(statusField);

  if (res.ok && !isErrorEnvelope) {
    return { created: true };
  }
  if (/already exists|duplicate/i.test(message)) {
    return { created: false };
  }
  throw new DoltHubApiError(
    `Create branch ${opts.newBranch} on ${opts.owner}/${opts.db} failed (${res.status}): ${message || res.statusText || 'no error body'}`,
    res.status
  );
}

// ── Write API with polling ────────────────────────────────────────────

const WriteResponse = z
  .object({
    operation_name: z.string().optional(),
    query_execution_status: z.string().optional(),
    query_execution_message: z.string().optional(),
  })
  .passthrough();

const PollResponse = z
  .object({
    done: z.boolean().default(false),
    res_details: z
      .object({
        query_execution_status: z.string().optional(),
        query_execution_message: z.string().optional(),
        // DoltHub returns these on a successful commit. `to_commit_id`
        // being non-null and distinct from `from_commit_id` is the
        // only reliable proof that the write actually landed —
        // `query_execution_status: 'Success'` alone can be returned
        // for no-op writes.
        from_commit_id: z.string().nullable().optional(),
        to_commit_id: z.string().nullable().optional(),
      })
      .passthrough()
      .optional(),
    // Some legacy responses surface the same fields at the top level.
    query_execution_status: z.string().optional(),
    query_execution_message: z.string().optional(),
  })
  .passthrough();

export type ExecWriteResult = {
  /** True iff DoltHub produced a real new commit on `toBranch`. */
  committed: boolean;
  fromCommitId: string | null;
  toCommitId: string | null;
  /** DoltHub's reported `query_execution_status` from the polled
   *  operation. `'Success'` / `'SuccessWithWarning'` on the happy
   *  path; the empty string when DoltHub returns done=true with no
   *  status. Surfaced for diagnostic logging. */
  status: string;
  /** DoltHub's reported `query_execution_message`. Often empty on
   *  success; populated on errors and warnings. */
  message: string;
};

/**
 * Issue a single SQL statement against the DoltHub write API and wait
 * for the resulting async operation to complete. Mirrors
 * `RemoteDB.execOne` + `pollOperation` in
 * `wasteland/internal/backend/remote.go`.
 *
 * `fromBranch`/`toBranch` follow the upstream's branch-fork model:
 * the write commits onto a new commit on `toBranch` parented from
 * `fromBranch`. If `toBranch` doesn't exist, DoltHub creates it
 * from `fromBranch`.
 *
 * Returns enough context (commit IDs + DoltHub's status/message
 * fields) for the orchestrator to log per-statement diagnostics and
 * detect silent no-ops.
 */
export async function execWrite(
  token: string,
  opts: {
    owner: string;
    db: string;
    fromBranch: string;
    toBranch: string;
    sql: string;
    /** Polling timeout. Defaults to 2 minutes (matches RemoteDB). */
    timeoutMs?: number;
  }
): Promise<ExecWriteResult> {
  const writePath = `/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.db)}/write/${encodeURIComponent(opts.fromBranch)}/${encodeURIComponent(opts.toBranch)}?q=${encodeURIComponent(opts.sql)}`;
  const writeRes = await fetch(`${DOLTHUB_API_BASE}${writePath}`, {
    method: 'POST',
    headers: {
      'cache-control': 'no-cache',
      authorization: `token ${token}`,
    },
  });
  const writeBodyText = await writeRes.text().catch(() => '');
  let writeRaw: unknown = {};
  try {
    writeRaw = JSON.parse(writeBodyText);
  } catch {
    /* keep writeRaw as {} */
  }
  if (!writeRes.ok) {
    throw new DoltHubApiError(
      `Write API failed (${writeRes.status}) for ${opts.owner}/${opts.db}: ${writeBodyText.slice(0, 400) || writeRes.statusText}`,
      writeRes.status
    );
  }
  const writeParsed = WriteResponse.safeParse(writeRaw);
  if (!writeParsed.success) {
    throw new DoltHubApiError(
      `Write API returned an unexpected response shape: ${writeBodyText.slice(0, 400)}`,
      writeRes.status
    );
  }
  const writeData = writeParsed.data;
  if (writeData.query_execution_status === 'Error') {
    throw new DoltHubApiError(
      `Write operation failed: ${writeData.query_execution_message ?? 'unknown error'}`,
      400
    );
  }

  // Synchronous success — no operation_name to poll. With no commit
  // info available, conservatively report committed=false.
  if (!writeData.operation_name) {
    return {
      committed: false,
      fromCommitId: null,
      toCommitId: null,
      status: writeData.query_execution_status ?? '',
      message: writeData.query_execution_message ?? '',
    };
  }

  return pollWriteOperation(token, {
    owner: opts.owner,
    db: opts.db,
    operationName: writeData.operation_name,
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
}

/**
 * Poll `GET /{owner}/{db}/write?operationName=…` until the async write
 * job completes. Resolves with an `ExecWriteResult` carrying the
 * commit IDs and DoltHub's status/message; throws `DoltHubApiError`
 * on failure or timeout.
 *
 * Matches `RemoteDB.pollOperation`'s contract:
 *   - exponential backoff capped at 8s
 *   - five consecutive transport errors fail fast
 *   - `toCommitId`-null is reported as committed=false (a real no-op)
 *   - `done: true` with status=Error is a failure
 *   - 4xx poll responses fail fast and surface the body
 */
async function pollWriteOperation(
  token: string,
  opts: { owner: string; db: string; operationName: string; timeoutMs: number }
): Promise<ExecWriteResult> {
  let backoffMs = 500;
  const deadline = Date.now() + opts.timeoutMs;
  let consecutiveErrors = 0;
  let lastError: string | null = null;
  const url = `${DOLTHUB_API_BASE}/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.db)}/write?operationName=${encodeURIComponent(opts.operationName)}`;

  while (Date.now() < deadline) {
    await sleep(backoffMs);

    let res: Response;
    try {
      res = await fetch(url, {
        headers: {
          'cache-control': 'no-cache',
          authorization: `token ${token}`,
        },
      });
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (/sqlwrite\.tocommitid/i.test(lastError)) {
        // Transport-level surface of the same "no commit produced"
        // signal that the 400 path catches below.
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
        throw new DoltHubApiError(
          `Polling write operation ${opts.operationName} failed: ${lastError}`,
          502
        );
      }
      if (backoffMs < 8_000) backoffMs *= 2;
      continue;
    }

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      const lower = errBody.toLowerCase();

      // HTTP 400 mentioning `sqlwrite.toCommitId` has two flavors:
      //
      // 1. **Benign no-op** — the SQL ran but produced no commit
      //    (e.g. `INSERT IGNORE` against an existing row, or
      //    `ON DUPLICATE KEY UPDATE` with identical values). The
      //    response body is just the bare error string with no
      //    `query_execution_status` envelope.
      //
      // 2. **Real DoltHub error** — the operation envelope carries
      //    `query_execution_status: "Error"` and a meaningful
      //    `query_execution_message` (e.g. "Cannot return null for
      //    non-nullable field SqlWrite.toCommitId" when the parent
      //    branch doesn't exist on a freshly-created repo). We
      //    have to inspect the JSON body to distinguish these,
      //    because the bare-text and JSON shapes both contain the
      //    word "toCommitId".
      if (res.status === 400 && lower.includes('sqlwrite.tocommitid')) {
        let parsedBody: { query_execution_status?: string; query_execution_message?: string } = {};
        try {
          parsedBody = JSON.parse(errBody) as typeof parsedBody;
        } catch {
          /* bare text body, fall through to no-op success */
        }
        if (parsedBody.query_execution_status?.toLowerCase() === 'error') {
          throw new DoltHubApiError(
            `Write operation ${opts.operationName} failed: ${parsedBody.query_execution_message ?? 'unknown error'}`,
            400
          );
        }
        return {
          committed: false,
          fromCommitId: null,
          toCommitId: null,
          status: '',
          message: errBody.slice(0, 400),
        };
      }

      lastError = `HTTP ${res.status}${errBody ? `: ${errBody.slice(0, 400)}` : ''}`;
      consecutiveErrors++;
      const failFast = res.status >= 400 && res.status < 500;
      if (failFast || consecutiveErrors >= 5) {
        throw new DoltHubApiError(
          `Polling write operation ${opts.operationName} failed: ${lastError}`,
          res.status
        );
      }
      if (backoffMs < 8_000) backoffMs *= 2;
      continue;
    }
    consecutiveErrors = 0;

    const raw: unknown = await res.json().catch(() => ({}));
    const parsed = PollResponse.safeParse(raw);
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
        throw new DoltHubApiError(
          `Write operation ${opts.operationName} failed: ${message || 'unknown error'}`,
          400
        );
      }
      if (lower === 'success' || lower === 'successwithwarning') {
        return { committed, fromCommitId, toCommitId, status, message };
      }
      if (parsed.data.done) {
        if (status === '') {
          throw new DoltHubApiError(
            `Write operation ${opts.operationName} finished with unknown status`,
            500
          );
        }
        return { committed, fromCommitId, toCommitId, status, message };
      }
    }

    if (backoffMs < 8_000) backoffMs *= 2;
  }

  throw new DoltHubApiError(
    `Timed out waiting for write operation ${opts.operationName}` +
      (lastError ? ` (last error: ${lastError})` : ''),
    504
  );
}

// ── Branch merge ──────────────────────────────────────────────────────

/**
 * Merge `fromBranch` into `toBranch` via the SQL write API's empty-query
 * mode. Per DoltHub's docs:
 *
 * > Once we're satisfied with our changes, we can merge our branches by
 * > hitting the first endpoint with an empty query.
 *
 * Returns an `ExecWriteResult` for parity with `execWrite`.
 */
export async function mergeBranchIntoMain(
  token: string,
  opts: {
    owner: string;
    db: string;
    fromBranch: string;
    toBranch: string;
    timeoutMs?: number;
  }
): Promise<ExecWriteResult> {
  const writePath = `/${encodeURIComponent(opts.owner)}/${encodeURIComponent(opts.db)}/write/${encodeURIComponent(opts.fromBranch)}/${encodeURIComponent(opts.toBranch)}`;
  const writeRes = await fetch(`${DOLTHUB_API_BASE}${writePath}`, {
    method: 'POST',
    headers: {
      'cache-control': 'no-cache',
      authorization: `token ${token}`,
    },
  });
  const writeBodyText = await writeRes.text().catch(() => '');
  let writeRaw: unknown = {};
  try {
    writeRaw = JSON.parse(writeBodyText);
  } catch {
    /* keep writeRaw as {} */
  }
  if (!writeRes.ok) {
    throw new DoltHubApiError(
      `Merge ${opts.fromBranch}→${opts.toBranch} on ${opts.owner}/${opts.db} failed (${writeRes.status}): ${writeBodyText.slice(0, 400)}`,
      writeRes.status
    );
  }
  const writeParsed = WriteResponse.safeParse(writeRaw);
  if (!writeParsed.success) {
    throw new DoltHubApiError(
      `Merge API returned an unexpected response shape: ${writeBodyText.slice(0, 400)}`,
      writeRes.status
    );
  }
  const writeData = writeParsed.data;
  if (writeData.query_execution_status === 'Error') {
    throw new DoltHubApiError(
      `Merge ${opts.fromBranch}→${opts.toBranch} failed: ${writeData.query_execution_message ?? 'unknown error'}`,
      400
    );
  }
  if (!writeData.operation_name) {
    return {
      committed: false,
      fromCommitId: null,
      toCommitId: null,
      status: writeData.query_execution_status ?? '',
      message: writeData.query_execution_message ?? '',
    };
  }
  return pollWriteOperation(token, {
    owner: opts.owner,
    db: opts.db,
    operationName: writeData.operation_name,
    timeoutMs: opts.timeoutMs ?? 120_000,
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── SQL escaping ──────────────────────────────────────────────────────

/**
 * Escape a string for use inside a single-quoted SQL literal. Mirrors
 * `escapeSQLString` in `wasteland/internal/federation/federation.go`
 * verbatim: backslash → `\\`, single-quote → doubled. No other chars
 * are transformed because callers validate input shape (rig handles,
 * DoltHub orgs) before reaching the bootstrap path.
 */
export function escapeSqlString(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "''");
}
