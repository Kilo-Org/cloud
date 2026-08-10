import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import { db, readDb } from '@/lib/drizzle';
import { dispatchUserDataExport } from '@/lib/user-data-export-worker-client';
import { adminProcedure, createTRPCRouter } from '@/lib/trpc/init';
import { isSoftDeletedBlockedReason } from '@kilocode/db/user-soft-delete';
import {
  classifyExportHealth,
  type ExportEmailStatus,
  type ExportHealthInput,
  type ExportStatus,
} from './user-data-export-health';

const ExportStatusSchema = z.enum([
  'queued',
  'processing',
  'finalizing',
  'ready',
  'failed',
  'expired',
]);
const EmailStatusSchema = z.enum(['pending', 'sending', 'sent', 'failed']);
const HealthFilterSchema = z.enum(['needs_attention', 'active', 'terminal', 'all']);
const ListInputSchema = z.object({
  page: z.number().int().positive().default(1),
  limit: z.number().int().min(1).max(100).default(25),
  health: HealthFilterSchema.default('needs_attention'),
  status: ExportStatusSchema.optional(),
  emailStatus: EmailStatusSchema.optional(),
  search: z.string().trim().min(1).max(320).optional(),
});
const DetailInputSchema = z.object({ exportId: z.string().uuid() });
const RecoveryInputSchema = z.object({
  exportId: z.string().uuid(),
  expectedGeneration: z.number().int().min(0).max(2_147_483_646),
});

const ACTIVE_STATUSES = ['queued', 'processing', 'finalizing'] as const;

type ExportRow = {
  id: string;
  kilo_user_id: string;
  user_email: string;
  user_name: string | null;
  status: ExportStatus;
  schema_version: number;
  snapshot_at: string;
  current_source: string | null;
  has_source_cursor: boolean;
  has_persisted_parts: boolean;
  has_multipart_upload: boolean;
  has_worker_lease: boolean;
  next_part_number: number;
  dispatch_generation: number;
  attempt_count: number;
  row_count: number | string;
  size_bytes: number | string | null;
  lease_expires_at: string | null;
  failure_code: string | null;
  last_error_redacted: string | null;
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
  email_status: ExportEmailStatus;
  email_attempt_count: number;
  email_lease_expires_at: string | null;
  email_sent_at: string | null;
  has_r2_object: boolean;
  current_outbox_id: string | null;
  current_outbox_available_at: string | null;
  current_outbox_attempt_count: number | null;
  current_outbox_sent_at: string | null;
  has_other_usable_export: boolean;
};

type DetailRow = ExportRow & {
  part_count: number | string;
  checkpoint_size_bytes: number | string;
  first_part_number: number | null;
  last_part_number: number | null;
  outbox_generations: number | string;
  pending_generations: number | string;
};

type OutboxRow = {
  id: string;
  generation: number;
  operation: 'generate';
  available_at: string;
  attempt_count: number;
  sent_at: string | null;
  created_at: string;
  updated_at: string;
};

type RecoveryTarget = {
  id: string;
  kilo_user_id: string;
  status: ExportStatus;
  schema_version: number;
  snapshot_at: string;
  requested_at: string;
  dispatch_generation: number;
  lease_expires_at: string | null;
  multipart_upload_id: string | null;
  r2_object_key: string | null;
};

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

function iso(value: string): string {
  return new Date(value).toISOString();
}

function nullableIso(value: string | null): string | null {
  return value === null ? null : iso(value);
}

function number(value: number | string | null): number | null {
  if (value === null) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) ? result : null;
}

function objectKey(exportId: string): string {
  return `exports/${exportId}/kilo-data-export.jsonl.gz`;
}

function conflict(message: string): never {
  throw new TRPCError({ code: 'CONFLICT', message });
}

async function lockRecoveryTarget(
  tx: DbTransaction,
  input: z.infer<typeof RecoveryInputSchema>
): Promise<RecoveryTarget> {
  const initial = await tx.execute<{ kilo_user_id: string }>(sql`
    SELECT kilo_user_id FROM user_data_exports WHERE id = ${input.exportId} LIMIT 1
  `);
  const ownerId = initial.rows[0]?.kilo_user_id;
  if (!ownerId) throw new TRPCError({ code: 'NOT_FOUND', message: 'Data export not found' });

  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))`);
  const owner = await tx.execute<{ id: string; blocked_reason: string | null }>(sql`
    SELECT id, blocked_reason FROM kilocode_users WHERE id = ${ownerId} FOR UPDATE
  `);
  const ownerRow = owner.rows[0];
  if (!ownerRow || isSoftDeletedBlockedReason(ownerRow.blocked_reason)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The export owner is no longer eligible for recovery',
    });
  }

  const target = await tx.execute<RecoveryTarget>(sql`
    SELECT id, kilo_user_id, status, schema_version, snapshot_at, requested_at,
      dispatch_generation, lease_expires_at, multipart_upload_id, r2_object_key
    FROM user_data_exports
    WHERE id = ${input.exportId}
    FOR UPDATE
  `);
  const row = target.rows[0];
  if (!row) conflict('This export changed while the recovery action was being prepared');
  if (row.dispatch_generation !== input.expectedGeneration) {
    conflict('This export changed after the page loaded. Refresh before trying again');
  }
  if (row.r2_object_key !== null && row.r2_object_key !== objectKey(row.id)) {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message: 'The export has an unexpected artifact key and requires investigation',
    });
  }
  return row;
}

async function scheduleCleanup(
  tx: DbTransaction,
  target: RecoveryTarget,
  reason: 'admin_cancel' | 'admin_replace'
): Promise<void> {
  await tx.execute(sql`
    INSERT INTO user_data_export_object_deletions (
      object_key, multipart_upload_id, reason, available_at
    ) VALUES (
      ${objectKey(target.id)}, ${target.multipart_upload_id}, ${reason},
      GREATEST(now(), COALESCE(${target.lease_expires_at}::timestamptz + interval '5 minutes', now()))
    )
    ON CONFLICT (object_key) DO UPDATE
    SET multipart_upload_id = COALESCE(
          EXCLUDED.multipart_upload_id,
          user_data_export_object_deletions.multipart_upload_id
        ),
        available_at = GREATEST(
          user_data_export_object_deletions.available_at,
          EXCLUDED.available_at
        ),
        updated_at = now()
  `);
}

async function dispatchAfterCommit(input: {
  exportId: string;
  generation: number;
  kiloUserId: string;
}) {
  const result = await dispatchUserDataExport(input);
  return { dispatch: result.kind === 'accepted' ? ('sent' as const) : ('pending' as const) };
}

function healthInput(row: ExportRow): ExportHealthInput {
  return {
    status: row.status,
    attemptCount: row.attempt_count,
    leaseExpiresAt: nullableIso(row.lease_expires_at),
    hasWorkerLease: row.has_worker_lease,
    currentOutboxId: row.current_outbox_id,
    currentOutboxAvailableAt: nullableIso(row.current_outbox_available_at),
    currentOutboxSentAt: nullableIso(row.current_outbox_sent_at),
    currentOutboxAttemptCount: row.current_outbox_attempt_count,
    hasMultipartUpload: row.has_multipart_upload,
    hasLegacyGeneratorState:
      row.current_source !== null ||
      row.has_source_cursor ||
      row.next_part_number !== 1 ||
      row.has_persisted_parts,
    hasR2Object: row.has_r2_object,
    expiresAt: nullableIso(row.expires_at),
    emailStatus: row.email_status,
    emailAttemptCount: row.email_attempt_count,
    emailLeaseExpiresAt: nullableIso(row.email_lease_expires_at),
  };
}

function serialize(row: ExportRow, asOf: string) {
  return {
    id: row.id,
    user: { id: row.kilo_user_id, email: row.user_email, name: row.user_name },
    status: row.status,
    schemaVersion: row.schema_version,
    currentSource: row.current_source,
    nextPartNumber: row.next_part_number,
    dispatchGeneration: row.dispatch_generation,
    attemptCount: row.attempt_count,
    rowCount: number(row.row_count) ?? 0,
    sizeBytes: number(row.size_bytes),
    requestedAt: iso(row.requested_at),
    startedAt: nullableIso(row.started_at),
    completedAt: nullableIso(row.completed_at),
    expiresAt: nullableIso(row.expires_at),
    updatedAt: iso(row.updated_at),
    leaseExpiresAt: nullableIso(row.lease_expires_at),
    failureCode: row.failure_code,
    failureMessage: row.last_error_redacted,
    emailStatus: row.email_status,
    emailAttemptCount: row.email_attempt_count,
    health: classifyExportHealth(healthInput(row), asOf),
  };
}

const needsAttentionSql = sql`
  (
    e.status = 'failed'
    OR (e.status IN ('queued', 'processing', 'finalizing') AND o.id IS NULL)
    OR (e.status IN ('processing', 'finalizing') AND e.lease_expires_at < now())
    OR (e.status IN ('queued', 'processing', 'finalizing') AND COALESCE(o.attempt_count, 0) > 0)
    OR (e.status = 'failed' AND e.multipart_upload_id IS NOT NULL)
    OR (e.status = 'ready' AND e.expires_at <= now() AND e.r2_object_key IS NOT NULL)
    OR (
      e.status = 'ready' AND e.expires_at > now()
      AND (
        e.email_status = 'failed'
        OR (
          e.email_attempt_count > 0
          AND (
            e.email_status = 'pending'
            OR (e.email_status = 'sending' AND e.email_lease_expires_at < now())
          )
        )
      )
    )
    OR (e.status NOT IN ('queued', 'processing', 'finalizing') AND e.lease_token IS NOT NULL)
    OR (e.status = 'queued' AND e.lease_token IS NOT NULL)
    OR (e.status = 'finalizing' AND e.lease_token IS NULL)
    OR (e.current_source IS NOT NULL OR e.source_cursor IS NOT NULL OR e.next_part_number <> 1)
    OR EXISTS (SELECT 1 FROM user_data_export_parts legacy_parts WHERE legacy_parts.export_id = e.id)
  )
`;

function listConditions(input: z.infer<typeof ListInputSchema>) {
  const conditions = [];
  if (input.health === 'needs_attention') conditions.push(needsAttentionSql);
  if (input.health === 'active')
    conditions.push(sql`e.status IN ('queued', 'processing', 'finalizing')`);
  if (input.health === 'terminal') conditions.push(sql`e.status IN ('ready', 'failed', 'expired')`);
  if (input.status) conditions.push(sql`e.status = ${input.status}`);
  if (input.emailStatus) conditions.push(sql`e.email_status = ${input.emailStatus}`);
  if (input.search) {
    conditions.push(sql`(
      e.id::text = ${input.search}
      OR e.kilo_user_id = ${input.search}
      OR lower(u.google_user_email) = lower(${input.search})
    )`);
  }
  return conditions.length === 0 ? sql`` : sql`WHERE ${sql.join(conditions, sql` AND `)}`;
}

// Keep this fragment clause-free; list and detail append their own WHERE/ORDER/LIMIT clauses.
const baseSelect = sql`
  SELECT
    e.id, e.kilo_user_id, u.google_user_email AS user_email,
    u.google_user_name AS user_name, e.status, e.schema_version, e.snapshot_at,
    e.current_source, e.source_cursor IS NOT NULL AS has_source_cursor,
    EXISTS (
      SELECT 1 FROM user_data_export_parts persisted_parts WHERE persisted_parts.export_id = e.id
    ) AS has_persisted_parts,
    e.multipart_upload_id IS NOT NULL AS has_multipart_upload,
    e.lease_token IS NOT NULL AS has_worker_lease,
    e.next_part_number, e.dispatch_generation, e.attempt_count,
    e.row_count::text AS row_count, e.size_bytes::text AS size_bytes,
    e.lease_expires_at, e.failure_code, e.last_error_redacted,
    e.requested_at, e.started_at, e.completed_at, e.expires_at, e.created_at, e.updated_at,
    e.email_status, e.email_attempt_count, e.email_lease_expires_at, e.email_sent_at,
    e.r2_object_key IS NOT NULL AS has_r2_object,
    EXISTS (
      SELECT 1 FROM user_data_exports other
      WHERE other.kilo_user_id = e.kilo_user_id AND other.id <> e.id
        AND (
          other.status IN ('queued', 'processing', 'finalizing')
          OR (other.status = 'ready' AND other.expires_at > now())
        )
    ) AS has_other_usable_export,
    o.id AS current_outbox_id, o.available_at AS current_outbox_available_at,
    o.attempt_count AS current_outbox_attempt_count, o.sent_at AS current_outbox_sent_at
  FROM user_data_exports e
  INNER JOIN kilocode_users u ON u.id = e.kilo_user_id
  LEFT JOIN user_data_export_outbox o
    ON o.export_id = e.id
    AND o.generation = e.dispatch_generation
    AND o.operation = 'generate'
`;

export const adminUserDataExportsRouter = createTRPCRouter({
  summary: adminProcedure.query(async () => {
    const result = await readDb.execute<{
      as_of: string;
      active: number | string;
      needs_attention: number | string;
      stale_leases: number | string;
      pending_dispatches: number | string;
      failed: number | string;
      cleanup_due: number | string;
      email_unhealthy: number | string;
      oldest_pending_at: string | null;
    }>(sql`
      SELECT now() AS as_of,
        count(*) FILTER (WHERE e.status IN ('queued', 'processing', 'finalizing'))::text AS active,
        count(*) FILTER (WHERE ${needsAttentionSql})::text AS needs_attention,
        count(*) FILTER (
          WHERE e.status IN ('processing', 'finalizing') AND e.lease_expires_at < now()
        )::text AS stale_leases,
        count(*) FILTER (
          WHERE e.status IN ('queued', 'processing', 'finalizing')
            AND o.sent_at IS NULL AND o.available_at <= now()
        )::text AS pending_dispatches,
        count(*) FILTER (WHERE e.status = 'failed')::text AS failed,
        count(*) FILTER (
          WHERE (e.status = 'failed' AND e.multipart_upload_id IS NOT NULL)
            OR (e.status = 'ready' AND e.expires_at <= now() AND e.r2_object_key IS NOT NULL)
        )::text AS cleanup_due,
        count(*) FILTER (
          WHERE e.status = 'ready' AND e.expires_at > now() AND (
            e.email_status = 'failed'
            OR (
              e.email_attempt_count > 0
              AND (
                e.email_status = 'pending'
                OR (e.email_status = 'sending' AND e.email_lease_expires_at < now())
              )
            )
          )
        )::text AS email_unhealthy,
        min(o.available_at) FILTER (
          WHERE e.status IN ('queued', 'processing', 'finalizing')
            AND o.sent_at IS NULL AND o.available_at <= now()
        ) AS oldest_pending_at
      FROM user_data_exports e
      LEFT JOIN user_data_export_outbox o
        ON o.export_id = e.id
        AND o.generation = e.dispatch_generation
        AND o.operation = 'generate'
    `);
    const row = result.rows[0];
    const deletionResult = await readDb.execute<{ due: number | string }>(sql`
      SELECT count(*)::text AS due
      FROM user_data_export_object_deletions
      WHERE available_at <= now()
    `);
    return {
      asOf: row ? iso(row.as_of) : new Date().toISOString(),
      active: number(row?.active ?? 0) ?? 0,
      needsAttention: number(row?.needs_attention ?? 0) ?? 0,
      staleLeases: number(row?.stale_leases ?? 0) ?? 0,
      pendingDispatches: number(row?.pending_dispatches ?? 0) ?? 0,
      failed: number(row?.failed ?? 0) ?? 0,
      cleanupDue:
        (number(row?.cleanup_due ?? 0) ?? 0) + (number(deletionResult.rows[0]?.due ?? 0) ?? 0),
      emailUnhealthy: number(row?.email_unhealthy ?? 0) ?? 0,
      oldestPendingAt: row ? nullableIso(row.oldest_pending_at) : null,
    };
  }),

  list: adminProcedure.input(ListInputSchema).query(async ({ input }) => {
    const where = listConditions(input);
    const offset = (input.page - 1) * input.limit;
    const [asOfResult, rowsResult, totalResult] = await Promise.all([
      readDb.execute<{ as_of: string }>(sql`SELECT now() AS as_of`),
      readDb.execute<ExportRow>(sql`
        ${baseSelect}
        ${where}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT ${input.limit} OFFSET ${offset}
      `),
      readDb.execute<{ total: number | string }>(sql`
        SELECT count(*)::text AS total
        FROM user_data_exports e
        INNER JOIN kilocode_users u ON u.id = e.kilo_user_id
        LEFT JOIN user_data_export_outbox o
          ON o.export_id = e.id
          AND o.generation = e.dispatch_generation
          AND o.operation = 'generate'
        ${where}
      `),
    ]);
    const asOf = iso(asOfResult.rows[0]?.as_of ?? new Date().toISOString());
    const total = number(totalResult.rows[0]?.total ?? 0) ?? 0;
    return {
      asOf,
      rows: rowsResult.rows.map(row => serialize(row, asOf)),
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        totalPages: Math.ceil(total / input.limit),
      },
    };
  }),

  detail: adminProcedure.input(DetailInputSchema).query(async ({ input }) => {
    const asOfResult = await readDb.execute<{ as_of: string }>(sql`SELECT now() AS as_of`);
    const asOf = iso(asOfResult.rows[0]?.as_of ?? new Date().toISOString());
    const detailResult = await readDb.execute<DetailRow>(sql`
      WITH part_stats AS (
        SELECT export_id, count(*)::text AS part_count,
          COALESCE(sum(size_bytes), 0)::text AS checkpoint_size_bytes,
          min(part_number) AS first_part_number, max(part_number) AS last_part_number
        FROM user_data_export_parts WHERE export_id = ${input.exportId}
        GROUP BY export_id
      ), outbox_stats AS (
        SELECT export_id, count(*)::text AS outbox_generations,
          count(*) FILTER (WHERE sent_at IS NULL)::text AS pending_generations
        FROM user_data_export_outbox WHERE export_id = ${input.exportId}
        GROUP BY export_id
      )
      SELECT base.*,
        COALESCE(ps.part_count, '0') AS part_count,
        COALESCE(ps.checkpoint_size_bytes, '0') AS checkpoint_size_bytes,
        ps.first_part_number, ps.last_part_number,
        COALESCE(os.outbox_generations, '0') AS outbox_generations,
        COALESCE(os.pending_generations, '0') AS pending_generations
      FROM (${baseSelect} WHERE e.id = ${input.exportId}) base
      LEFT JOIN part_stats ps ON ps.export_id = base.id
      LEFT JOIN outbox_stats os ON os.export_id = base.id
      LIMIT 1
    `);
    const row = detailResult.rows[0];
    if (!row) throw new TRPCError({ code: 'NOT_FOUND', message: 'Data export not found' });
    const outboxResult = await readDb.execute<OutboxRow>(sql`
      SELECT id, generation, operation, available_at, attempt_count, sent_at, created_at, updated_at
      FROM user_data_export_outbox
      WHERE export_id = ${input.exportId}
      ORDER BY generation DESC
      LIMIT 50
    `);
    const serialized = serialize(row, asOf);
    const partCount = number(row.part_count) ?? 0;
    const integrityWarnings: string[] = [];
    if (row.status === 'finalizing' && !row.has_multipart_upload)
      integrityWarnings.push('finalizing_without_multipart');
    if (row.has_worker_lease && !row.lease_expires_at)
      integrityWarnings.push('worker_lease_shape_invalid');
    if (
      row.current_source !== null ||
      row.has_source_cursor ||
      row.next_part_number !== 1 ||
      partCount > 0
    )
      integrityWarnings.push('retired_generator_state');
    if (['queued', 'processing', 'finalizing'].includes(row.status) && !row.current_outbox_id)
      integrityWarnings.push('current_outbox_missing');

    const active = ACTIVE_STATUSES.includes(row.status as (typeof ACTIVE_STATUSES)[number]);
    const liveLease =
      row.lease_expires_at !== null &&
      new Date(row.lease_expires_at).getTime() > new Date(asOf).getTime();
    const actions = {
      redispatch: {
        eligible: active && !liveLease && !row.has_r2_object,
        disabledReason: !active
          ? 'Only active exports can be redispatched.'
          : liveLease
            ? `A worker lease is active until ${iso(row.lease_expires_at ?? asOf)}.`
            : row.has_r2_object
              ? 'This export already records a completed artifact. Cancel and retry it instead.'
              : null,
      },
      cancelAndPurge: { eligible: true, disabledReason: null },
      cancelAndRetry: {
        eligible: !row.has_other_usable_export,
        disabledReason: row.has_other_usable_export
          ? 'This user already has another active or downloadable export.'
          : null,
      },
    };

    return {
      ...serialized,
      snapshotAt: iso(row.snapshot_at),
      hasSourceCursor: row.has_source_cursor,
      hasMultipartUpload: row.has_multipart_upload,
      hasR2Object: row.has_r2_object,
      emailLeaseExpiresAt: nullableIso(row.email_lease_expires_at),
      emailSentAt: nullableIso(row.email_sent_at),
      parts: {
        count: partCount,
        checkpointSizeBytes: number(row.checkpoint_size_bytes) ?? 0,
        firstPartNumber: row.first_part_number,
        lastPartNumber: row.last_part_number,
      },
      outbox: {
        generations: number(row.outbox_generations) ?? 0,
        pendingGenerations: number(row.pending_generations) ?? 0,
        items: outboxResult.rows.map(item => ({
          id: item.id,
          generation: item.generation,
          operation: item.operation,
          attemptCount: item.attempt_count,
          availableAt: iso(item.available_at),
          sentAt: nullableIso(item.sent_at),
          createdAt: iso(item.created_at),
          updatedAt: iso(item.updated_at),
          isCurrentGeneration: item.generation === row.dispatch_generation,
        })),
      },
      integrityWarnings,
      actions,
    };
  }),

  redispatch: adminProcedure.input(RecoveryInputSchema).mutation(async ({ input }) => {
    const result = await db.transaction(async tx => {
      const target = await lockRecoveryTarget(tx, input);
      if (!ACTIVE_STATUSES.includes(target.status as (typeof ACTIVE_STATUSES)[number])) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Only active exports can be redispatched',
        });
      }
      if (target.lease_expires_at && new Date(target.lease_expires_at).getTime() > Date.now()) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'A worker is still processing this export',
        });
      }
      if (target.r2_object_key !== null) {
        throw new TRPCError({
          code: 'PRECONDITION_FAILED',
          message: 'Exports with completed artifacts must be canceled and retried',
        });
      }
      const nextGeneration = target.dispatch_generation + 1;
      await tx.execute(sql`
        DELETE FROM user_data_export_outbox
        WHERE export_id = ${target.id} AND sent_at IS NULL
      `);
      const updated = await tx.execute<{ id: string }>(sql`
        UPDATE user_data_exports
        SET status = 'queued', dispatch_generation = ${nextGeneration},
          current_source = NULL, source_cursor = NULL, next_part_number = 1,
          lease_token = NULL, lease_expires_at = NULL, attempt_count = 0,
          row_count = 0, size_bytes = NULL, r2_object_key = NULL, r2_etag = NULL,
          failure_code = NULL, last_error_redacted = NULL,
          started_at = NULL, completed_at = NULL, expires_at = NULL,
          email_status = 'pending', email_attempt_count = 0,
          email_lease_token = NULL, email_lease_expires_at = NULL, email_sent_at = NULL,
          updated_at = now()
        WHERE id = ${target.id} AND dispatch_generation = ${target.dispatch_generation}
        RETURNING id
      `);
      if (!updated.rows[0]) conflict('This export changed while it was being redispatched');
      await tx.execute(sql`DELETE FROM user_data_export_parts WHERE export_id = ${target.id}`);
      await tx.execute(sql`
        INSERT INTO user_data_export_outbox (export_id, generation, operation, available_at)
        VALUES (${target.id}, ${nextGeneration}, 'generate', now())
      `);
      return { exportId: target.id, kiloUserId: target.kilo_user_id, generation: nextGeneration };
    });
    return {
      exportId: result.exportId,
      generation: result.generation,
      ...(await dispatchAfterCommit(result)),
    };
  }),

  cancelAndPurge: adminProcedure.input(RecoveryInputSchema).mutation(async ({ input }) => {
    const result = await db.transaction(async tx => {
      const target = await lockRecoveryTarget(tx, input);
      await scheduleCleanup(tx, target, 'admin_cancel');
      const deleted = await tx.execute<{ id: string }>(sql`
        DELETE FROM user_data_exports
        WHERE id = ${target.id} AND dispatch_generation = ${target.dispatch_generation}
        RETURNING id
      `);
      if (!deleted.rows[0]) conflict('This export changed while it was being canceled');
      return { exportId: target.id };
    });
    return { ...result, cleanup: 'queued' as const };
  }),

  cancelAndRetry: adminProcedure.input(RecoveryInputSchema).mutation(async ({ input }) => {
    const result = await db.transaction(async tx => {
      const target = await lockRecoveryTarget(tx, input);
      const blocker = await tx.execute<{ id: string }>(sql`
        SELECT id FROM user_data_exports
        WHERE kilo_user_id = ${target.kilo_user_id} AND id <> ${target.id}
          AND (
            status IN ('queued', 'processing', 'finalizing')
            OR (status = 'ready' AND expires_at > now())
          )
        LIMIT 1
      `);
      if (blocker.rows[0]) {
        conflict('This user already has another active or downloadable export');
      }
      await scheduleCleanup(tx, target, 'admin_replace');
      const deleted = await tx.execute<{ id: string }>(sql`
        DELETE FROM user_data_exports
        WHERE id = ${target.id} AND dispatch_generation = ${target.dispatch_generation}
        RETURNING id
      `);
      if (!deleted.rows[0]) conflict('This export changed while it was being replaced');
      const replacement = await tx.execute<{
        id: string;
        kilo_user_id: string;
        dispatch_generation: number;
      }>(sql`
        INSERT INTO user_data_exports (kilo_user_id, schema_version, snapshot_at, requested_at)
        VALUES (
          ${target.kilo_user_id}, ${target.schema_version},
          ${target.snapshot_at}::timestamptz, ${target.requested_at}::timestamptz
        )
        RETURNING id, kilo_user_id, dispatch_generation
      `);
      const row = replacement.rows[0];
      if (!row) throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Retry failed' });
      await tx.execute(sql`
        INSERT INTO user_data_export_outbox (export_id, generation, operation, available_at)
        VALUES (${row.id}, ${row.dispatch_generation}, 'generate', now())
      `);
      return {
        exportId: row.id,
        replacementExportId: row.id,
        kiloUserId: row.kilo_user_id,
        generation: row.dispatch_generation,
      };
    });
    return {
      exportId: result.exportId,
      replacementExportId: result.replacementExportId,
      generation: result.generation,
      cleanup: 'queued' as const,
      ...(await dispatchAfterCommit(result)),
    };
  }),
});
