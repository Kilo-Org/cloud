import { getWorkerDb, pg } from '@kilocode/db/client';
import { sql } from 'drizzle-orm';
import type { ExportCursor } from './contracts';
import type { ReplicaQuery } from './source-adapters';

export type HyperdriveBinding = { connectionString: string };
export type StateDb = ReturnType<typeof createStateDb>;

export type ExportJob = {
  id: string;
  kilo_user_id: string;
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

type Part = { part_number: number; etag: string };
type PendingNotification = { id: string };
type StoredObject = { id: string; r2_object_key: string };
type MultipartUpload = { id: string; multipart_upload_id: string };
type ReadyExportObject = { r2_object_key: string; expires_at: string };
type ObjectDeletion = { object_key: string; multipart_upload_id: string | null };

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
            lease_token = ${leaseToken}, lease_expires_at = now() + interval '14 minutes',
            attempt_count = attempt_count + 1, started_at = COALESCE(started_at, now()), updated_at = now()
        WHERE id = ${exportId} AND dispatch_generation = ${generation}
          AND status IN ('queued', 'processing', 'finalizing')
          AND (lease_expires_at IS NULL OR lease_expires_at < now())
        RETURNING id, kilo_user_id, status, snapshot_at, requested_at, current_source, source_cursor, multipart_upload_id,
          next_part_number, dispatch_generation, lease_token, r2_object_key
      `);
      return rows.rows[0] ?? null;
    },
    async checkpoint(input: {
      exportId: string;
      leaseToken: string;
      parts: Array<{ partNumber: number; etag: string; sizeBytes: number }>;
      rowCount: number;
      cursor: ExportCursor | null;
      nextSource: string | null;
      nextGeneration: number;
      multipartUploadId: string;
    }): Promise<boolean> {
      const nextPartNumber = input.parts.at(-1)?.partNumber;
      if (nextPartNumber === undefined) throw new Error('Export checkpoint has no parts');
      const rows = await db.execute<{ id: string }>(sql`
        WITH candidate AS (
          SELECT id
          FROM user_data_exports
          WHERE id = ${input.exportId} AND lease_token = ${input.leaseToken}
          FOR UPDATE
        ), input_parts AS (
          SELECT * FROM jsonb_to_recordset(${JSON.stringify(input.parts)}::jsonb)
            AS part("partNumber" integer, etag text, "sizeBytes" bigint)
        ), inserted_parts AS (
          INSERT INTO user_data_export_parts (export_id, part_number, etag, size_bytes)
          SELECT candidate.id, part."partNumber", part.etag, part."sizeBytes"
          FROM candidate CROSS JOIN input_parts AS part
          RETURNING export_id
        ), updated AS (
          UPDATE user_data_exports AS exports
          SET source_cursor = ${JSON.stringify(input.cursor)}::jsonb,
            current_source = ${input.nextSource}, next_part_number = ${nextPartNumber + 1},
            multipart_upload_id = ${input.multipartUploadId}, dispatch_generation = ${input.nextGeneration},
            row_count = exports.row_count + ${input.rowCount}, attempt_count = 0,
            lease_token = NULL, lease_expires_at = NULL, updated_at = now()
          FROM (SELECT DISTINCT export_id FROM inserted_parts) AS inserted
          WHERE exports.id = inserted.export_id AND exports.lease_token = ${input.leaseToken}
          RETURNING exports.id
        )
        INSERT INTO user_data_export_outbox (export_id, generation, operation, available_at)
        SELECT id, ${input.nextGeneration}, 'generate', now() FROM updated
        ON CONFLICT (export_id, generation, operation) DO NOTHING
        RETURNING export_id AS id
      `);
      return rows.rows.length > 0;
    },
    async complete(input: {
      exportId: string;
      leaseToken: string;
      objectKey: string;
      etag: string;
      sizeBytes: number;
    }): Promise<boolean> {
      const rows = await db.execute<{ id: string }>(sql`
        UPDATE user_data_exports
        SET status = 'ready', r2_object_key = ${input.objectKey}, r2_etag = ${input.etag}, size_bytes = ${input.sizeBytes},
          completed_at = now(), expires_at = now() + interval '7 days', multipart_upload_id = NULL,
          lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = ${input.exportId} AND status = 'finalizing' AND lease_token = ${input.leaseToken}
        RETURNING id
      `);
      return rows.rows.length > 0;
    },
    async markFailed(
      exportId: string,
      generation: number,
      failureCode = 'queue_delivery_exhausted'
    ): Promise<void> {
      await db.execute(sql`
        UPDATE user_data_exports SET status = 'failed', failure_code = ${failureCode},
          last_error_redacted = 'The export could not be completed after multiple attempts.',
          lease_token = NULL, lease_expires_at = NULL, updated_at = now()
        WHERE id = ${exportId} AND dispatch_generation = ${generation}
          AND status IN ('queued', 'processing', 'finalizing')
      `);
    },
    async pendingOutbox(): Promise<ExportQueueRow[]> {
      const rows = await db.execute<ExportQueueRow>(sql`
        SELECT id, export_id, generation FROM user_data_export_outbox
        WHERE sent_at IS NULL AND available_at <= now() ORDER BY created_at LIMIT 100
      `);
      return rows.rows;
    },
    async markOutboxSent(id: string): Promise<void> {
      await db.execute(
        sql`UPDATE user_data_export_outbox SET sent_at = now(), updated_at = now() WHERE id = ${id}`
      );
    },
    async markOutboxGenerationSent(exportId: string, generation: number): Promise<void> {
      await db.execute(sql`
        UPDATE user_data_export_outbox SET sent_at = now(), updated_at = now()
        WHERE export_id = ${exportId} AND generation = ${generation} AND operation = 'generate'
      `);
    },
    async readyObject(exportId: string, kiloUserId: string): Promise<ReadyExportObject | null> {
      const rows = await db.execute<ReadyExportObject>(sql`
        SELECT r2_object_key, expires_at
        FROM user_data_exports
        WHERE id = ${exportId} AND kilo_user_id = ${kiloUserId}
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
    async parts(exportId: string): Promise<Part[]> {
      const rows = await db.execute<Part>(sql`
        SELECT part_number, etag FROM user_data_export_parts WHERE export_id = ${exportId} ORDER BY part_number
      `);
      return rows.rows;
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

export function createReplicaQuery(binding: HyperdriveBinding): ReplicaQuery {
  return async (text: string, values: unknown[]): Promise<Record<string, unknown>[]> => {
    const client = new pg.Client({
      connectionString: binding.connectionString,
      statement_timeout: 30_000,
    });
    try {
      await client.connect();
      await client.query('BEGIN READ ONLY');
      const result = await client.query<Record<string, unknown>>(text, values);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  };
}
