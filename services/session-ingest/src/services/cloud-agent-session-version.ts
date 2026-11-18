import { and, eq, sql } from 'drizzle-orm';
import type { WorkerDb } from '@kilocode/db/client';
import { cli_sessions_v2 } from '@kilocode/db/schema';
import {
  CLI_SESSION_VERSION_BY_RUNTIME_HARNESS,
  type RecordCloudAgentSessionHarnessParams,
} from '@kilocode/session-ingest-contracts';

export async function setCloudAgentSessionVersion(
  db: Pick<WorkerDb, 'update'>,
  input: RecordCloudAgentSessionHarnessParams
): Promise<boolean> {
  const version = CLI_SESSION_VERSION_BY_RUNTIME_HARNESS[input.runtimeHarness];
  const rows = await db
    .update(cli_sessions_v2)
    // A runtime record is not session activity, so it keeps the list position.
    .set({ version, updated_at: sql`${cli_sessions_v2.updated_at}` })
    .where(
      and(
        eq(cli_sessions_v2.session_id, input.sessionId),
        eq(cli_sessions_v2.kilo_user_id, input.kiloUserId),
        eq(cli_sessions_v2.cloud_agent_session_id, input.cloudAgentSessionId)
      )
    )
    .returning({ version: cli_sessions_v2.version });
  return rows.length > 0;
}
