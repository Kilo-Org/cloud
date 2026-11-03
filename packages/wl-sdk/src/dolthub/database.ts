/**
 * DoltHub database creation and forking.
 *
 *   POST /database          — create a new database
 *   POST /fork              — fork an existing database
 *
 * `createDatabase` defaults to `'public'` because DoltHub's free tier
 * rejects `'private'` with HTTP 400, and the wl-commons schema is
 * collaborative by design — private should be an explicit opt-in.
 *
 * Both endpoints return either a synchronous result or an async
 * envelope with an `operation_name`. For `/fork`, the operation
 * polls under the `/fork?operationName=…` endpoint (NOT under
 * `/{owner}/{db}/...`) — see `pollForkOperation` in
 * `wasteland/internal/remote/dolthub.go`.
 */

import { z } from 'zod';
import {
  type DoltHubAuth,
  type DoltFetchHooks,
  buildDoltUrl,
  doltFetch,
  WlDoltHubError,
} from './api';
import { pollOperation } from './operation';

const CreateDatabaseResponse = z
  .object({
    status: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
    repository_owner: z.string().optional(),
    repository_name: z.string().optional(),
  })
  .passthrough();

const ForkResponse = z
  .object({
    status: z.string().optional(),
    operation_name: z.string().optional(),
    message: z.string().optional(),
    error: z.string().optional(),
    // A synchronous success names the fork it created.
    owner_name: z.string().optional(),
    database_name: z.string().optional(),
  })
  .passthrough();

/** Statuses that confirm an operation DoltHub finished successfully. */
const CONFIRMED_STATUS = /^(success|created|done|completed)$/i;

export type CreateDatabaseOptions = {
  auth: DoltHubAuth;
  owner: string;
  db: string;
  visibility?: 'public' | 'private';
  description?: string;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

export type ForkDatabaseOptions = {
  auth: DoltHubAuth;
  fromOwner: string;
  fromDb: string;
  toOwner: string;
  /** Defaults to `fromDb`. DoltHub's REST fork endpoint does not let
   *  you rename a fork; this is exposed only because the Go SDK's
   *  signature accepts it for parity. Passing a different value will
   *  be rejected by DoltHub. */
  toDb?: string;
  /** Polling timeout (ms). Defaults to 2 minutes. */
  timeoutMs?: number;
  /** Inject sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  hooks?: DoltFetchHooks;
};

export type ForkDatabaseResult = {
  owner: string;
  db: string;
  /** True only when DoltHub confirmed the fork this call created —
   *  synchronously by reporting a terminal success status, or by naming
   *  the fork when it states no status, or through a polled operation
   *  that completed. False when DoltHub reported that the fork already
   *  existed. */
  created: boolean;
};

export type CreateDatabaseResult = {
  /** True on a fresh create; false if DoltHub reported "already exists". */
  created: boolean;
};

/**
 * Create a new DoltHub database. Idempotent — pre-existing repos
 * resolve as `{ created: false }`.
 *
 * `visibility` defaults to `'public'` (free-tier DoltHub rejects
 * private; the wl-commons schema is collaborative).
 */
export async function createDatabase(opts: CreateDatabaseOptions): Promise<CreateDatabaseResult> {
  const path = '/database';
  const body = {
    ownerName: opts.owner,
    repoName: opts.db,
    visibility: opts.visibility ?? 'public',
    ...(opts.description ? { description: opts.description } : {}),
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

  if (res.status === 409) return { created: false };

  const parsed = CreateDatabaseResponse.safeParse(res.json ?? {});
  const message = parsed.success ? (parsed.data.message ?? parsed.data.error ?? '') : '';
  const statusField = parsed.success ? (parsed.data.status ?? '') : '';
  const isErrorEnvelope = /^error$/i.test(statusField);

  if (res.status >= 200 && res.status < 300 && !isErrorEnvelope) {
    return { created: true };
  }
  if (/already exists|duplicate/i.test(message)) {
    return { created: false };
  }
  throw new WlDoltHubError(
    `Create database ${opts.owner}/${opts.db} failed (${res.status}): ${
      message || res.text || 'no error body'
    }`,
    res.status,
    res.json ?? res.text,
    url
  );
}

/**
 * Fork `fromOwner/fromDb` under `toOwner`. Returns the new fork's
 * `{owner, db, created}`. Idempotent: if the fork already exists,
 * resolves with `created: false`.
 *
 * If DoltHub returns an `operation_name`, polls the `/fork` endpoint
 * until the operation completes. A response that does not confirm the
 * fork is an error, never `created: true`: a status the body states must
 * be a terminal success, and a body that states no status must name the
 * fork. Reported names never override a stated non-success status.
 */
export async function forkDatabase(opts: ForkDatabaseOptions): Promise<ForkDatabaseResult> {
  const path = '/fork';
  const targetDb = opts.toDb ?? opts.fromDb;
  const body = {
    ownerName: opts.toOwner,
    parentOwnerName: opts.fromOwner,
    parentDatabaseName: opts.fromDb,
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

  const parsed = ForkResponse.safeParse(res.json ?? {});
  const message = parsed.success ? (parsed.data.message ?? parsed.data.error ?? '') : '';

  if (res.status < 200 || res.status >= 300) {
    if (/already exists|duplicate/i.test(message) || /already exists/i.test(res.text)) {
      return { owner: opts.toOwner, db: targetDb, created: false };
    }
    throw new WlDoltHubError(
      `Fork ${opts.fromOwner}/${opts.fromDb} → ${opts.toOwner}/${targetDb} failed (${res.status}): ${
        message || res.text || 'no error body'
      }`,
      res.status,
      res.json ?? res.text,
      url
    );
  }

  // 2xx but with an "already exists" envelope → idempotent success.
  if (/already exists|duplicate/i.test(message)) {
    return { owner: opts.toOwner, db: targetDb, created: false };
  }

  // DoltHub answers some failures with a 2xx `{status: 'Error'}` body.
  // `created` certifies that this token made the fork, so an error
  // envelope can never resolve as a new fork.
  const statusField = parsed.success ? (parsed.data.status ?? '').trim() : '';
  const errorField = parsed.success ? (parsed.data.error ?? '').trim() : '';
  if (/^error$/i.test(statusField) || errorField.length > 0) {
    throw new WlDoltHubError(
      `Fork ${opts.fromOwner}/${opts.fromDb} → ${opts.toOwner}/${targetDb} failed: ${
        message || errorField || 'DoltHub reported an error'
      }`,
      res.status,
      res.json ?? res.text,
      url
    );
  }

  const operationName = parsed.success ? parsed.data.operation_name : undefined;
  if (!operationName) {
    // No operation to follow. `created` certifies that this token made
    // the fork under `toOwner`, so only a body that positively
    // describes that fork resolves as new: either it names the fork, or
    // it reports a terminal success status. A body this code cannot
    // read, a status it does not recognize, and a body naming another
    // owner or database all leave the fork unconfirmed — an accepted
    // operation that cannot be followed is not a success either.
    const reportedOwner = parsed.success ? (parsed.data.owner_name ?? '').trim() : '';
    const reportedDb = parsed.success ? (parsed.data.database_name ?? '').trim() : '';
    const namesTarget =
      reportedOwner.toLowerCase() === opts.toOwner.toLowerCase() &&
      reportedDb.toLowerCase() === targetDb.toLowerCase();
    const namesOther =
      (reportedOwner.length > 0 && reportedOwner.toLowerCase() !== opts.toOwner.toLowerCase()) ||
      (reportedDb.length > 0 && reportedDb.toLowerCase() !== targetDb.toLowerCase());
    // A status the body states decides on its own: only a terminal
    // success confirms the fork, and any other stated status — error,
    // pending, running, queued, in progress, or one this client does not
    // know — leaves it unconfirmed even when the body also names the
    // target. Reporting the requested names is not evidence that the
    // fork finished. Only a body that states no status at all may stand
    // on the names it reports.
    const confirmed = statusField.length > 0 ? CONFIRMED_STATUS.test(statusField) : namesTarget;
    if (!parsed.success || namesOther || !confirmed) {
      throw new WlDoltHubError(
        `Fork ${opts.fromOwner}/${opts.fromDb} → ${opts.toOwner}/${targetDb} is unconfirmed: ${
          statusField.length > 0
            ? `DoltHub reported "${statusField}", which does not confirm this fork`
            : 'the response does not describe this fork'
        }`,
        res.status,
        res.json ?? res.text,
        url
      );
    }
    return { owner: opts.toOwner, db: targetDb, created: true };
  }

  await pollOperation({
    auth: opts.auth,
    owner: opts.toOwner,
    db: targetDb,
    operationName,
    endpoint: 'fork',
    timeoutMs: opts.timeoutMs,
    sleep: opts.sleep,
    fetch: opts.fetch,
    hooks: opts.hooks,
  });
  return { owner: opts.toOwner, db: targetDb, created: true };
}
