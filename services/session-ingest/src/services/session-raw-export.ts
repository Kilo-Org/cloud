import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { getWorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import { storedSessionIdSchema } from '@kilocode/session-ingest-contracts';
import { withDORetry } from '@kilocode/worker-utils';
import type { Env } from '../env';
import { getSessionIngestDO } from '../dos/SessionIngestDO';

/**
 * One raw session read, addressed by the two values the Durable Object name is
 * built from. `requireSessionRow` is the gate that keeps an export from
 * instantiating a Durable Object for a session nothing was ever stored for: the
 * `isDeleted()` probe every session-create path already runs instantiates the
 * object, so a `cli_sessions_v2` row is a sound existence signal, while a
 * missing row is not proof of absence (a legacy or direct-ingest session has
 * storage but no row). Callers therefore pass `false` only for a pair they
 * deliberately want probed.
 */
export const sessionRawExportRequestSchema = z.object({
  kiloUserId: z.string().min(1).max(255),
  // Every id a stored row can hold, not only the canonical `ses_…` shape: a
  // session created earlier keeps its id, and its rows are addressed by it.
  sessionId: storedSessionIdSchema,
  requireSessionRow: z.boolean().optional(),
  // Opaque caller-side identifier for the audit line, so one export can be
  // traced back to the job that asked for it.
  exportId: z.string().min(1).max(128).optional(),
  // Opt-in cleanup for a session that stores nothing at all: the export resets
  // the Durable Object's storage instead of leaving an empty object behind.
  // `false` (the default) keeps the export read-only.
  deleteIfEmpty: z.boolean().optional(),
});

export type SessionRawExportRequest = z.infer<typeof sessionRawExportRequestSchema>;

export type SessionRawExportResult =
  | { status: 'ok'; stream: ReadableStream<Uint8Array> }
  | { status: 'no_session_row' };

/**
 * Stream a session's stored rows as NDJSON for an internal export.
 *
 * Read-only: the gate query only selects, and the Durable Object method it calls
 * only selects, so this is safe against a live session. No user credential is
 * involved — authorization is the route's dedicated export token — and the
 * caller is trusted to have established that the pair belongs in the export.
 */
export async function getSessionRawExport(
  env: Env,
  input: SessionRawExportRequest
): Promise<SessionRawExportResult> {
  if (input.requireSessionRow !== false) {
    const db = getWorkerDb(env.HYPERDRIVE.connectionString);
    const row = await db
      .select({ session_id: cli_sessions_v2.session_id })
      .from(cli_sessions_v2)
      .where(
        and(
          eq(cli_sessions_v2.session_id, input.sessionId),
          eq(cli_sessions_v2.kilo_user_id, input.kiloUserId)
        )
      )
      .limit(1);
    if (row.length === 0) return { status: 'no_session_row' };
  }

  const stream = await withDORetry(
    () => getSessionIngestDO(env, { kiloUserId: input.kiloUserId, sessionId: input.sessionId }),
    stub => stub.exportSessionRowsStream({ deleteIfEmpty: input.deleteIfEmpty === true }),
    'SessionIngestDO.exportSessionRowsStream'
  );

  return { status: 'ok', stream };
}
