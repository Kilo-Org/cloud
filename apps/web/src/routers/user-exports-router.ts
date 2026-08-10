import 'server-only';

import { TRPCError } from '@trpc/server';
import { sql } from 'drizzle-orm';
import * as z from 'zod';
import { db } from '@/lib/drizzle';
import { baseProcedure, createTRPCRouter } from '@/lib/trpc/init';
import {
  dispatchUserDataExport,
  requestUserDataExportDownload,
} from '@/lib/user-data-export-worker-client';

const ExportIdSchema = z.object({ exportId: z.string().uuid() });
const ListInputSchema = z.object({ cursor: z.string().uuid().optional() }).optional();
const PAGE_SIZE = 20;
const EXPORT_DATA_CUTOFF = '2026-08-02T08:40:00.000Z';

type UserExportRow = {
  id: string;
  status: 'queued' | 'processing' | 'finalizing' | 'ready' | 'failed' | 'expired';
  requested_at: string;
  started_at: string | null;
  completed_at: string | null;
  expires_at: string | null;
  size_bytes: number | string | null;
  row_count: number | string | null;
  failure_message: string | null;
  dispatch_generation: number;
};

function toIso(value: string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

function toNumber(value: number | string | null): number | null {
  return value === null ? null : Number(value);
}

function requiredIso(value: string): string {
  return new Date(value).toISOString();
}

function serialize(row: UserExportRow) {
  return {
    id: row.id,
    status: row.status,
    requestedAt: requiredIso(row.requested_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    expiresAt: toIso(row.expires_at),
    sizeBytes: toNumber(row.size_bytes),
    rowCount: toNumber(row.row_count),
    failureMessage: row.failure_message,
  };
}

function requireWebSession(authViaToken: boolean | undefined): void {
  if (authViaToken) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'A web session is required for data exports',
    });
  }
}

export const userExportsRouter = createTRPCRouter({
  request: baseProcedure.mutation(async ({ ctx }) => {
    requireWebSession(ctx.authViaToken);
    const { rows } = await db.transaction(async tx => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${ctx.user.id}, 0))`);
      const existing = await tx.execute<UserExportRow>(sql`
        SELECT id, status, requested_at, started_at, completed_at, expires_at, size_bytes, row_count,
          last_error_redacted AS failure_message, dispatch_generation
        FROM user_data_exports
        WHERE kilo_user_id = ${ctx.user.id}
          -- Only short-circuit on an in-progress export (return it instead of starting a
          -- duplicate generation). A completed/ready export must not block requesting a
          -- fresh one; that is governed solely by the re-request throttle below.
          AND status IN ('queued', 'processing', 'finalizing')
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `);
      if (existing.rows[0]) return existing;

      const recent = await tx.execute<{ requested_at: string }>(sql`
        SELECT requested_at
        FROM user_data_exports
        WHERE kilo_user_id = ${ctx.user.id}
          AND status <> 'failed'
          -- TEMPORARY: throttle lowered to 5 minutes for pre-launch testing; restore to 24 hours before going live.
          AND requested_at > now() - interval '5 minutes'
        ORDER BY requested_at DESC
        LIMIT 1
      `);
      if (recent.rows[0]) {
        throw new TRPCError({
          code: 'TOO_MANY_REQUESTS',
          message: 'You can request one data export every 24 hours',
        });
      }

      return tx.execute<UserExportRow>(sql`
        WITH created AS (
          INSERT INTO user_data_exports (kilo_user_id, snapshot_at)
          VALUES (${ctx.user.id}, ${EXPORT_DATA_CUTOFF}::timestamptz)
          RETURNING id, status, requested_at, started_at, completed_at, expires_at, size_bytes, row_count,
            last_error_redacted AS failure_message, dispatch_generation
        ), outbox AS (
          INSERT INTO user_data_export_outbox (export_id, generation, operation, available_at)
          SELECT id, dispatch_generation, 'generate', now() FROM created
          ON CONFLICT (export_id, generation, operation) DO NOTHING
        )
        SELECT * FROM created
      `);
    });
    const row = rows[0];
    if (!row)
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: 'Export request failed' });

    // The outbox remains authoritative if the Worker is unavailable after commit.
    if (row.status === 'queued')
      await dispatchUserDataExport({
        exportId: row.id,
        generation: row.dispatch_generation,
        kiloUserId: ctx.user.id,
      });
    return serialize(row);
  }),

  list: baseProcedure.input(ListInputSchema).query(async ({ ctx, input }) => {
    requireWebSession(ctx.authViaToken);
    const cursorFilter = input?.cursor
      ? sql`AND (created_at, id) < (
          SELECT created_at, id FROM user_data_exports
          WHERE id = ${input.cursor} AND kilo_user_id = ${ctx.user.id}
        )`
      : sql``;
    const { rows } = await db.execute<UserExportRow>(sql`
          SELECT id, status, requested_at, started_at, completed_at, expires_at, size_bytes, row_count,
            last_error_redacted AS failure_message, dispatch_generation
      FROM user_data_exports
      WHERE kilo_user_id = ${ctx.user.id}
        ${cursorFilter}
      ORDER BY created_at DESC, id DESC
      LIMIT ${PAGE_SIZE + 1}
    `);
    const page = rows.slice(0, PAGE_SIZE);
    return {
      exports: page.map(serialize),
      nextCursor: rows.length > PAGE_SIZE ? (page.at(-1)?.id ?? null) : null,
    };
  }),

  createDownload: baseProcedure.input(ExportIdSchema).mutation(async ({ ctx, input }) => {
    requireWebSession(ctx.authViaToken);
    const { rows } = await db.execute<{ id: string }>(sql`
      SELECT id FROM user_data_exports
      WHERE id = ${input.exportId} AND kilo_user_id = ${ctx.user.id}
        AND status = 'ready' AND expires_at > now()
      LIMIT 1
    `);
    if (!rows[0]) throw new TRPCError({ code: 'NOT_FOUND', message: 'Export not found' });
    const result = await requestUserDataExportDownload({
      exportId: input.exportId,
      kiloUserId: ctx.user.id,
    });
    if (result.kind === 'unavailable') {
      throw new TRPCError({
        code: 'PRECONDITION_FAILED',
        message: 'Downloads are not available yet',
      });
    }
    return { downloadUrl: result.downloadUrl, expiresAt: result.expiresAt };
  }),
});

export const __test__ = { requireWebSession, serialize };
