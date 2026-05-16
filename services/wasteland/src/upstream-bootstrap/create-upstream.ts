/**
 * Worker-side reimplementation of the wasteland CLI's `wl create`.
 *
 * Reproduces the order of operations from
 * `wasteland/internal/federation/federation.go:Service.Create`:
 *
 *   1. Create the DoltHub repo (idempotent — pre-existing repos are
 *      treated as success so re-running the create flow after a
 *      partial failure converges instead of erroring out).
 *   2. Apply the commons schema as DDL via the SQL write API.
 *   3. Optionally stamp the wasteland's display name into `_meta`.
 *   4. INSERT the creator's row into `rigs` with `trust_level = 1`,
 *      using the same `ON DUPLICATE KEY UPDATE` shape as the upstream
 *      so retries don't fail with a duplicate-key error.
 *
 * Each statement is dispatched as its own write-API call and polled
 * to completion. Per-statement results (commit IDs + DoltHub's
 * `query_execution_status` / `query_execution_message`) are logged
 * so we can diagnose silent no-ops and "no commit produced"
 * regressions from the audit trail alone.
 */

import { parseUpstream, DoltHubApiError } from '../util/dolthub-api.util';
import { logger } from '../util/log.util';
import { COMMONS_SCHEMA_STATEMENTS, COMMONS_SCHEMA_VERSION } from './commons-schema';
import {
  createDatabase,
  execWrite,
  listBranches,
  mergeBranchIntoMain,
  escapeSqlString,
  type ExecWriteResult,
} from './dolthub-write';

/**
 * Branch the bootstrap writes go onto before being merged into `main`.
 * Same-branch writes (`from=main, to=main`) silently no-op on a
 * freshly-created DoltHub repo, so we stage every schema/rig
 * statement on a scratch branch and merge at the end.
 *
 * Static name so a partial run is recoverable on retry — the second
 * run sees the branch already exists and DoltHub fast-forwards.
 */
const BOOTSTRAP_BRANCH = 'bootstrap';

export type CreateUpstreamOptions = {
  /** DoltHub upstream string in `owner/db` form. */
  upstream: string;
  /** OAuth or API token with write rights on `upstream`. */
  token: string;
  /** Rig handle (e.g. the wasteland creator's chosen short name). */
  rigHandle: string;
  /** Human-readable display name for the rig. Falls back to handle. */
  rigDisplayName?: string;
  /** Email address recorded with the rig row. */
  ownerEmail: string;
  /** DoltHub org/username — recorded as `dolthub_org` on the rig. */
  dolthubOrg: string;
  /** Optional wasteland display name, written to `_meta`. */
  wastelandName?: string;
  /**
   * Repo visibility on creation. Defaults to `'public'` (DoltHub's
   * free tier rejects `'private'` with HTTP 400, and the wasteland
   * commons schema is collaborative by design — private should be an
   * explicit opt-in by the caller).
   */
  visibility?: 'public' | 'private';
  /**
   * Version string recorded as `gt_version` on the rig row. The
   * upstream CLI sets this to the wl binary version; from the worker
   * we tag the source as `cloud-worker:<schema-version>` so audit
   * logs can tell which writer registered each rig.
   */
  version?: string;
};

export type CreateUpstreamResult = {
  /** True if we created the repo; false if it already existed. */
  databaseCreated: boolean;
};

export class CreateUpstreamError extends Error {
  constructor(
    message: string,
    readonly stage:
      | 'parse-upstream'
      | 'create-database'
      | 'apply-schema'
      | 'register-rig'
      | 'set-name',
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'CreateUpstreamError';
  }
}

export async function createUpstream(opts: CreateUpstreamOptions): Promise<CreateUpstreamResult> {
  let owner: string;
  let db: string;
  try {
    ({ owner, db } = parseUpstream(opts.upstream));
  } catch (err) {
    throw new CreateUpstreamError(
      err instanceof Error ? err.message : String(err),
      'parse-upstream',
      err
    );
  }

  logger.info('createUpstream: starting', {
    upstream: opts.upstream,
    rigHandle: opts.rigHandle,
    dolthubOrg: opts.dolthubOrg,
  });

  // ── 1. Create the DoltHub database ──────────────────────────────────
  let databaseCreated: boolean;
  try {
    const result = await createDatabase(opts.token, {
      owner,
      db,
      visibility: opts.visibility ?? 'public',
    });
    databaseCreated = result.created;
    logger.info('createUpstream: createDatabase result', {
      upstream: opts.upstream,
      databaseCreated,
    });
  } catch (err) {
    throw new CreateUpstreamError(
      `Creating DoltHub database ${owner}/${db} failed: ${formatError(err)}`,
      'create-database',
      err
    );
  }

  // ── 2. Apply the commons schema onto the bootstrap branch ──────────
  // The first write uses `from=main, to=bootstrap` — DoltHub creates
  // `bootstrap` from `main` (which itself is created lazily on the
  // first write). Subsequent writes target `from=bootstrap,
  // to=bootstrap` so each commit walks the branch tip forward.
  //
  // Per-statement logging surfaces DoltHub's `query_execution_status`
  // and `query_execution_message` from the polled operation so we can
  // diagnose silent no-ops and unexpected error envelopes.
  let schemaCommits = 0;
  for (const [index, stmt] of COMMONS_SCHEMA_STATEMENTS.entries()) {
    const stmtIndex = index + 1;
    const stmtPreview = truncate(stmt.replace(/\s+/g, ' '), 120);
    const fromBranch = index === 0 ? 'main' : BOOTSTRAP_BRANCH;
    try {
      const result = await execWrite(opts.token, {
        owner,
        db,
        fromBranch,
        toBranch: BOOTSTRAP_BRANCH,
        sql: stmt,
      });
      if (result.committed) schemaCommits++;
      logger.info('createUpstream: schema statement applied', {
        upstream: opts.upstream,
        statement: `${stmtIndex}/${COMMONS_SCHEMA_STATEMENTS.length}`,
        from: fromBranch,
        to: BOOTSTRAP_BRANCH,
        committed: result.committed,
        status: result.status,
        message: result.message,
        fromCommitId: result.fromCommitId,
        toCommitId: result.toCommitId,
        sqlPreview: stmtPreview,
      });
    } catch (err) {
      logger.warn('createUpstream: schema statement threw', {
        upstream: opts.upstream,
        statement: `${stmtIndex}/${COMMONS_SCHEMA_STATEMENTS.length}`,
        from: fromBranch,
        to: BOOTSTRAP_BRANCH,
        sqlPreview: stmtPreview,
        error: formatError(err),
      });
      throw new CreateUpstreamError(
        `Applying commons schema failed at statement "${stmtPreview}": ${formatError(err)}`,
        'apply-schema',
        err
      );
    }
  }
  logger.info('createUpstream: schema apply complete', {
    upstream: opts.upstream,
    statements: COMMONS_SCHEMA_STATEMENTS.length,
    schemaCommits,
    databaseCreated,
  });
  if (databaseCreated && schemaCommits === 0) {
    throw new CreateUpstreamError(
      `Applied ${COMMONS_SCHEMA_STATEMENTS.length} schema statements to ${owner}/${db} on the ${BOOTSTRAP_BRANCH} branch, but DoltHub reported no commits — the database is empty.`,
      'apply-schema'
    );
  }

  // ── 3. Stamp the wasteland display name into _meta (best-effort) ───
  if (opts.wastelandName) {
    try {
      const metaSql = `INSERT IGNORE INTO _meta (\`key\`, value) VALUES ('wasteland_name', '${escapeSqlString(opts.wastelandName)}')`;
      const result = await execWrite(opts.token, {
        owner,
        db,
        fromBranch: BOOTSTRAP_BRANCH,
        toBranch: BOOTSTRAP_BRANCH,
        sql: metaSql,
      });
      logger.info('createUpstream: wasteland_name set', {
        upstream: opts.upstream,
        wastelandName: opts.wastelandName,
        committed: result.committed,
        status: result.status,
        message: result.message,
        toCommitId: result.toCommitId,
      });
    } catch (err) {
      throw new CreateUpstreamError(
        `Setting wasteland_name in _meta failed: ${formatError(err)}`,
        'set-name',
        err
      );
    }
  }

  // ── 4. Register the creator as the first rig ───────────────────────
  const handle = opts.rigHandle;
  const displayName = opts.rigDisplayName || opts.rigHandle;
  const hopUri = `hop://${opts.ownerEmail}/${handle}/`;
  const version = opts.version ?? `cloud-worker:${COMMONS_SCHEMA_VERSION}`;

  const rigSql =
    `INSERT INTO rigs (handle, display_name, dolthub_org, hop_uri, owner_email, gt_version, trust_level, registered_at, last_seen) ` +
    `VALUES ('${escapeSqlString(handle)}', '${escapeSqlString(displayName)}', '${escapeSqlString(opts.dolthubOrg)}', '${escapeSqlString(hopUri)}', '${escapeSqlString(opts.ownerEmail)}', '${escapeSqlString(version)}', 1, NOW(), NOW()) ` +
    `ON DUPLICATE KEY UPDATE display_name = '${escapeSqlString(displayName)}', dolthub_org = '${escapeSqlString(opts.dolthubOrg)}', hop_uri = '${escapeSqlString(hopUri)}', owner_email = '${escapeSqlString(opts.ownerEmail)}', gt_version = '${escapeSqlString(version)}', last_seen = NOW()`;

  let rigResult: ExecWriteResult;
  try {
    rigResult = await execWrite(opts.token, {
      owner,
      db,
      fromBranch: BOOTSTRAP_BRANCH,
      toBranch: BOOTSTRAP_BRANCH,
      sql: rigSql,
    });
    logger.info('createUpstream: rig registered', {
      upstream: opts.upstream,
      rigHandle: handle,
      committed: rigResult.committed,
      status: rigResult.status,
      message: rigResult.message,
      fromCommitId: rigResult.fromCommitId,
      toCommitId: rigResult.toCommitId,
    });
  } catch (err) {
    throw new CreateUpstreamError(
      `Registering rig "${handle}" on ${owner}/${db} failed: ${formatError(err)}`,
      'register-rig',
      err
    );
  }
  if (!rigResult.committed) {
    throw new CreateUpstreamError(
      `Rig INSERT for "${handle}" on ${owner}/${db} returned no commit — the row was not written. ` +
        `DoltHub status: ${rigResult.status || '(empty)'}; message: ${rigResult.message || '(empty)'}.`,
      'register-rig'
    );
  }

  // ── 5. Merge the bootstrap branch into main ────────────────────────
  try {
    const mergeResult = await mergeBranchIntoMain(opts.token, {
      owner,
      db,
      fromBranch: BOOTSTRAP_BRANCH,
      toBranch: 'main',
    });
    logger.info('createUpstream: merge bootstrap → main', {
      upstream: opts.upstream,
      committed: mergeResult.committed,
      status: mergeResult.status,
      message: mergeResult.message,
      fromCommitId: mergeResult.fromCommitId,
      toCommitId: mergeResult.toCommitId,
    });
    if (databaseCreated && !mergeResult.committed) {
      throw new CreateUpstreamError(
        `Merging ${BOOTSTRAP_BRANCH} into main on ${owner}/${db} produced no commit — main is still empty. ` +
          `DoltHub status: ${mergeResult.status || '(empty)'}; message: ${mergeResult.message || '(empty)'}.`,
        'apply-schema'
      );
    }
  } catch (err) {
    if (err instanceof CreateUpstreamError) throw err;
    throw new CreateUpstreamError(
      `Merging ${BOOTSTRAP_BRANCH} into main on ${owner}/${db} failed: ${formatError(err)}`,
      'apply-schema',
      err
    );
  }

  // Diagnostic: list the final branch state so failed bootstraps are
  // easier to diagnose from logs alone. Best-effort.
  try {
    const branches = await listBranches(opts.token, { owner, db });
    logger.info('createUpstream: complete', {
      upstream: opts.upstream,
      databaseCreated,
      branches,
    });
  } catch (err) {
    logger.warn('createUpstream: listBranches diagnostic failed', {
      upstream: opts.upstream,
      error: formatError(err),
    });
  }
  return { databaseCreated };
}

function formatError(err: unknown): string {
  if (err instanceof DoltHubApiError) return `${err.message} (status=${err.status})`;
  if (err instanceof Error) return err.message;
  return String(err);
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n)}…`;
}
