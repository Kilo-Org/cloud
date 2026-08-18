import { getWorkerDb, pg } from '@kilocode/db/client';
import { organizationExportAccess } from '@kilocode/db/organization-export-access';
import { sql } from 'drizzle-orm';
import { logExportEvent, safeError, setSpanFields, withSpan } from './observability';
import type { ReplicaQuery } from './source-adapters';

export type HyperdriveBinding = { connectionString: string };
export type StateDb = ReturnType<typeof createStateDb>;

export type ExportJob = {
  id: string;
  /** The requester, for both subject types. Not necessarily whose data this contains. */
  kilo_user_id: string;
  subject_type: 'user' | 'organization';
  /** Set exactly when subject_type is 'organization'; a CHECK constraint enforces it. */
  organization_id: string | null;
  status: 'queued' | 'processing' | 'finalizing' | 'ready' | 'failed' | 'expired';
  snapshot_at: string;
  requested_at: string;
  current_source: string | null;
  source_cursor: unknown;
  multipart_upload_id: string | null;
  next_part_number: number;
  dispatch_generation: number;
  lease_token: string | null;
  r2_object_key: string | null;
};

type PendingNotification = { id: string };
type StoredObject = { id: string; r2_object_key: string };
type MultipartUpload = { id: string; multipart_upload_id: string };
export type ExportCompletionResult = 'completed' | 'already_completed' | 'fenced';
type ReadyExportObject = { r2_object_key: string; expires_at: string };
type ObjectDeletion = { object_key: string; multipart_upload_id: string | null };

/**
 * Whether `kiloUserId` may reach an export row, for either subject type.
 *
 * A personal export is reachable only by the person it belongs to. An organization's
 * goes through the predicate shared with the web router, so this Worker and the request
 * path cannot disagree — which they once did, producing an export that generated,
 * showed as ready, and refused every download.
 *
 * Still evaluated here rather than trusted from the caller: this runs on the download
 * path, and a Worker that took the router's word for it would have no check at all. It
 * is also evaluated in the same statement as the row lookup, so a revoked admin loses
 * access immediately rather than at the next lease or cache expiry.
 */
function callerMayAccess(kiloUserId: string) {
  return sql`(
    (subject_type = 'user' AND kilo_user_id = ${kiloUserId})
    OR (
      subject_type = 'organization'
      AND organization_id IS NOT NULL
      AND ${organizationExportAccess({
        kiloUserId,
        organizationId: sql`user_data_exports.organization_id`,
      })}
    )
  )`;
}

export function createStateDb(binding: HyperdriveBinding) {
  const db = getWorkerDb(binding.connectionString, { statement_timeout: 30_000 });
  return {
    async claim(
      exportId: string,
      generation: number,
      leaseToken: string
    ): Promise<ExportJob | null> {
      const rows = await db.execute<ExportJob>(sql`
        UPDATE user_data_exports
        SET status = CASE
              WHEN current_source IS NULL AND multipart_upload_id IS NOT NULL THEN 'finalizing'
              ELSE 'processing'
            END,
            lease_token = ${leaseToken}, lease_expires_at = now() + interval '16 minutes',
            attempt_count = attempt_count + 1, started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE id = ${exportId} AND dispatch_generation = ${generation}
          AND status IN ('queued', 'processing', 'finalizing')
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
        RETURNING id, kilo_user_id, subject_type, organization_id, status, snapshot_at, requested_at,
          current_source, source_cursor, multipart_upload_id,
          next_part_number, dispatch_generation, lease_token, r2_object_key
      `);
      return rows.rows[0] ?? null;
    },
    async attachMultipartUpload(input: {
      exportId: string;
      generation: number;
      leaseToken: string;
      multipartUploadId: string;
    }): Promise<'attached' | 'deleted' | 'lost_lease'> {
      const rows = await db.execute<{ attached: boolean; export_exists: boolean }>(sql`
        WITH attached AS (
          UPDATE user_data_exports
          SET multipart_upload_id = ${input.multipartUploadId}, updated_at = now()
          WHERE id = ${input.exportId} AND dispatch_generation = ${input.generation}
            AND lease_token = ${input.leaseToken} AND multipart_upload_id IS NULL
          RETURNING id
        ), existing AS (
          SELECT EXISTS (SELECT 1 FROM user_data_exports WHERE id = ${input.exportId}) AS export_exists
        ), cleanup AS (
          INSERT INTO user_data_export_object_deletions (object_key, multipart_upload_id)
          SELECT ${`exports/${input.exportId}/kilo-data-export.jsonl.gz`}, ${input.multipartUploadId}
          WHERE NOT EXISTS (SELECT 1 FROM attached)
            AND NOT (SELECT export_exists FROM existing)
          ON CONFLICT (object_key) DO UPDATE
          SET multipart_upload_id = COALESCE(
              EXCLUDED.multipart_upload_id,
              user_data_export_object_deletions.multipart_upload_id
            ),
            available_at = now(), updated_at = now()
        )
        SELECT EXISTS (SELECT 1 FROM attached) AS attached,
          (SELECT export_exists FROM existing) AS export_exists
      `);
      const result = rows.rows[0];
      if (result?.attached) return 'attached';
      return result?.export_exists ? 'lost_lease' : 'deleted';
    },
    async clearClaimedMultipartUpload(input: {
      exportId: string;
      generation: number;
      leaseToken: string;
      multipartUploadId: string;
    }): Promise<boolean> {
      const rows = await db.execute<{ id: string }>(sql`
        UPDATE user_data_exports
        SET status = 'processing', multipart_upload_id = NULL, updated_at = now()
        WHERE id = ${input.exportId} AND dispatch_generation = ${input.generation}
          AND lease_token = ${input.leaseToken}
          AND multipart_upload_id = ${input.multipartUploadId}
        RETURNING id
      `);
      return rows.rows.length > 0;
    },
    async complete(input: {
      exportId: string;
      leaseToken: string;
      objectKey: string;
      etag: string;
      sizeBytes: number;
      rowCount: number;
    }): Promise<ExportCompletionResult> {
      const rows = await db.execute<{ result: ExportCompletionResult }>(sql`
        WITH completed AS (
          UPDATE user_data_exports
          SET status = 'ready', r2_object_key = ${input.objectKey}, r2_etag = ${input.etag}, size_bytes = ${input.sizeBytes},
            row_count = ${input.rowCount}, current_source = NULL, source_cursor = NULL,
            completed_at = now(), expires_at = now() + interval '24 hours', multipart_upload_id = NULL,
            lease_token = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE id = ${input.exportId} AND status = 'processing' AND lease_token = ${input.leaseToken}
          RETURNING id
        )
        SELECT CASE
          WHEN EXISTS (SELECT 1 FROM completed) THEN 'completed'
          WHEN EXISTS (
            SELECT 1 FROM user_data_exports
            WHERE id = ${input.exportId} AND status = 'ready'
              AND r2_object_key = ${input.objectKey} AND r2_etag = ${input.etag}
          ) THEN 'already_completed'
          ELSE 'fenced'
        END AS result
      `);
      return rows.rows[0]?.result ?? 'fenced';
    },
    async completedObjectMatches(input: {
      exportId: string;
      objectKey: string;
      etag: string;
    }): Promise<boolean> {
      const rows = await db.execute<{ matches: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1 FROM user_data_exports
          WHERE id = ${input.exportId} AND status = 'ready'
            AND r2_object_key = ${input.objectKey} AND r2_etag = ${input.etag}
        ) AS matches
      `);
      return rows.rows[0]?.matches ?? false;
    },
    async scheduleTerminalObjectDeletion(input: {
      exportId: string;
      objectKey: string;
    }): Promise<boolean> {
      const rows = await db.execute<{ object_key: string }>(sql`
        INSERT INTO user_data_export_object_deletions (object_key, available_at)
        SELECT ${input.objectKey}, now()
        FROM user_data_exports
        WHERE id = ${input.exportId} AND status IN ('failed', 'expired')
        ON CONFLICT (object_key) DO UPDATE
        SET available_at = LEAST(user_data_export_object_deletions.available_at, now()),
          updated_at = now()
        RETURNING object_key
      `);
      return rows.rows.length > 0;
    },
    async markFailed(
      exportId: string,
      generation: number,
      failureCode = 'queue_delivery_exhausted',
      redactedMessage = 'The export could not be completed after multiple attempts.'
    ): Promise<void> {
      await db.execute(sql`
        UPDATE user_data_exports SET status = 'failed', failure_code = ${failureCode},
          last_error_redacted = ${redactedMessage},
          lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = ${exportId} AND dispatch_generation = ${generation}
          AND status IN ('queued', 'processing', 'finalizing')
      `);
    },
    async markLeasedExportFailed(input: {
      exportId: string;
      generation: number;
      leaseToken: string;
      failureCode: string;
      redactedMessage: string;
    }): Promise<void> {
      await db.execute(sql`
        UPDATE user_data_exports SET status = 'failed', failure_code = ${input.failureCode},
          last_error_redacted = ${input.redactedMessage}, lease_token = NULL,
          lease_expires_at = NULL, updated_at = now()
        WHERE id = ${input.exportId} AND dispatch_generation = ${input.generation}
          AND status IN ('processing', 'finalizing') AND lease_token = ${input.leaseToken}
      `);
    },
    async pendingOutbox(): Promise<ExportQueueRow[]> {
      const rows = await db.execute<ExportQueueRow>(sql`
        SELECT outbox.id, outbox.export_id, outbox.generation
        FROM user_data_export_outbox outbox
        INNER JOIN user_data_exports exports
          ON exports.id = outbox.export_id
          AND exports.dispatch_generation = outbox.generation
          AND exports.status IN ('queued', 'processing', 'finalizing')
        WHERE outbox.sent_at IS NULL AND outbox.available_at <= now()
        ORDER BY outbox.created_at, outbox.id
        LIMIT 100
      `);
      return rows.rows;
    },
    async markOutboxSent(id: string): Promise<void> {
      await db.execute(
        sql`UPDATE user_data_export_outbox SET sent_at = now(), updated_at = now() WHERE id = ${id}`
      );
    },
    async recordOutboxFailure(id: string): Promise<void> {
      await db.execute(sql`
        UPDATE user_data_export_outbox
        SET attempt_count = attempt_count + 1,
          available_at = now() + make_interval(
            secs => LEAST(3600, 30 * power(2, LEAST(attempt_count, 7)))::integer
          ),
          updated_at = now()
        WHERE id = ${id} AND sent_at IS NULL
      `);
    },
    async markOutboxGenerationSent(exportId: string, generation: number): Promise<void> {
      await db.execute(sql`
        UPDATE user_data_export_outbox SET sent_at = now(), updated_at = now()
        WHERE export_id = ${exportId} AND generation = ${generation} AND operation = 'generate'
      `);
    },
    async exportGenerationBelongsToUser(
      exportId: string,
      generation: number,
      kiloUserId: string
    ): Promise<boolean> {
      const rows = await db.execute<{ id: string }>(sql`
        SELECT id FROM user_data_exports
        WHERE id = ${exportId}
          AND ${callerMayAccess(kiloUserId)}
          AND dispatch_generation = ${generation}
          AND status IN ('queued', 'processing', 'finalizing')
        LIMIT 1
      `);
      return rows.rows.length > 0;
    },
    async readyObject(exportId: string, kiloUserId: string): Promise<ReadyExportObject | null> {
      const rows = await db.execute<ReadyExportObject>(sql`
        SELECT r2_object_key, expires_at
        FROM user_data_exports
        WHERE id = ${exportId}
          AND ${callerMayAccess(kiloUserId)}
          AND status = 'ready' AND expires_at > now() AND r2_object_key IS NOT NULL
        LIMIT 1
      `);
      return rows.rows[0] ?? null;
    },
    async releaseForRetry(exportId: string, generation: number, leaseToken: string): Promise<void> {
      await db.execute(sql`
        UPDATE user_data_exports
        SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = ${exportId} AND dispatch_generation = ${generation}
          AND status IN ('processing', 'finalizing') AND lease_token = ${leaseToken}
      `);
    },
    async reconcile(): Promise<void> {
      await db.execute(sql`
        UPDATE user_data_exports
        SET status = 'failed', failure_code = 'processing_attempts_exhausted',
          last_error_redacted = 'The export could not be completed after multiple attempts.',
          lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE status IN ('processing', 'finalizing') AND attempt_count >= 5
          AND lease_expires_at < now()
      `);
      await db.execute(sql`
        WITH stale AS (
          UPDATE user_data_exports
          SET status = 'queued', lease_token = NULL, lease_expires_at = NULL, updated_at = now()
          WHERE status IN ('processing', 'finalizing') AND attempt_count < 5
            AND lease_expires_at < now()
          RETURNING id, dispatch_generation
        )
        UPDATE user_data_export_outbox AS outbox
        SET sent_at = NULL, available_at = now(), updated_at = now()
        FROM stale
        WHERE outbox.export_id = stale.id
          AND outbox.generation = stale.dispatch_generation
          AND outbox.operation = 'generate'
      `);
    },
    async expiredObjects(): Promise<StoredObject[]> {
      const rows = await db.execute<StoredObject>(sql`
        SELECT id, r2_object_key
        FROM user_data_exports
        WHERE status = 'ready' AND expires_at <= now() AND r2_object_key IS NOT NULL
        ORDER BY expires_at, id
        LIMIT 10
      `);
      return rows.rows;
    },
    async markExpired(exportId: string): Promise<void> {
      await db.execute(sql`
        UPDATE user_data_exports
        SET status = 'expired', r2_object_key = NULL, r2_etag = NULL, updated_at = now()
        WHERE id = ${exportId} AND status = 'ready' AND expires_at <= now()
      `);
    },
    async failedMultipartUploads(): Promise<MultipartUpload[]> {
      const rows = await db.execute<MultipartUpload>(sql`
        SELECT id, multipart_upload_id
        FROM user_data_exports
        WHERE status = 'failed' AND multipart_upload_id IS NOT NULL
        ORDER BY updated_at, id
        LIMIT 100
      `);
      return rows.rows;
    },
    async clearMultipartUpload(exportId: string): Promise<void> {
      await db.execute(sql`
        UPDATE user_data_exports
        SET multipart_upload_id = NULL, updated_at = now()
        WHERE id = ${exportId} AND status = 'failed'
      `);
    },
    async pendingObjectDeletions(): Promise<ObjectDeletion[]> {
      const rows = await db.execute<ObjectDeletion>(sql`
        SELECT object_key, multipart_upload_id
        FROM user_data_export_object_deletions
        WHERE available_at <= now()
        ORDER BY available_at, created_at, object_key
        LIMIT 100
      `);
      return rows.rows;
    },
    async completeObjectDeletion(objectKey: string): Promise<void> {
      await db.execute(sql`
        DELETE FROM user_data_export_object_deletions WHERE object_key = ${objectKey}
      `);
    },
    async recordObjectDeletionFailure(objectKey: string): Promise<void> {
      await db.execute(sql`
        UPDATE user_data_export_object_deletions
        SET attempt_count = attempt_count + 1,
          available_at = now() + make_interval(
            secs => LEAST(3600, 30 * power(2, LEAST(attempt_count, 7)))::integer
          ),
          updated_at = now()
        WHERE object_key = ${objectKey}
      `);
    },
    async pendingNotifications(): Promise<PendingNotification[]> {
      const rows = await db.execute<PendingNotification>(sql`
        SELECT id
        FROM user_data_exports
        WHERE status = 'ready' AND expires_at > now()
          AND email_attempt_count < 4
          AND (email_status = 'pending'
            OR (email_status = 'sending' AND email_lease_expires_at < now()))
        ORDER BY completed_at, id
        LIMIT 100
      `);
      return rows.rows;
    },
  };
}

type ExportQueueRow = { id: string; export_id: string; generation: number };

export type ReplicaDatabase = {
  query: ReplicaQuery;
  close: () => Promise<void>;
};

type ReplicaPool = {
  query: (text: string, values: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  end: () => Promise<void>;
};

/**
 * Build one invocation-scoped warehouse connection pool.
 *
 * `database` only labels spans, so pass the logical binding name rather than anything
 * derived from the connection string, which carries credentials.
 *
 * Every source page an export reads passes through here, and Hyperdrive is not
 * auto-instrumented, so this is the one place that can make read cost visible. The pool
 * has one client because pages are read sequentially. Keeping it for the invocation avoids
 * reconnecting for every page while still preventing I/O state from crossing invocations.
 * Callers must await each query before starting the next; max: 1 is a guard, not a source
 * of query parallelism.
 *
 * The query text is intentionally not recorded. The enclosing per-source span already
 * identifies which of the six queries ran, so the text would add bytes to every span
 * without adding information, and keeping it out avoids growing the exported surface.
 */
export function createReplicaDatabase(
  binding: HyperdriveBinding,
  database: string,
  createPool: (config: pg.PoolConfig) => ReplicaPool = config => {
    const pool = new pg.Pool(config);
    // node-postgres emits idle-client failures through EventEmitter rather than through
    // query(). Without a listener they become uncaught errors for the invocation.
    pool.on('error', error => {
      logExportEvent('warn', 'postgres_pool_error', {
        database,
        ...safeError(error),
      });
    });
    return {
      query: (text, values) => pool.query<Record<string, unknown>>(text, values),
      end: () => pool.end(),
    };
  }
): ReplicaDatabase {
  const pool = createPool({
    connectionString: binding.connectionString,
    max: 1,
    statement_timeout: 30_000,
  });
  return {
    query: (text, values) =>
      withSpan(
        'postgres_read_page',
        { 'db.system.name': 'postgresql', 'db.name': database },
        async span => {
          try {
            const result = await pool.query(text, values);
            span.setAttribute('db.response.returned_rows', result.rows.length);
            return result.rows;
          } catch (error) {
            span.setAttribute('db.read.failed', true);
            setSpanFields(span, safeError(error));
            throw error;
          }
        }
      ),
    close: () => pool.end(),
  };
}

export const __test__ = { callerMayAccess };
